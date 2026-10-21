#import "images.h"
#import <Cocoa/Cocoa.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <Vision/Vision.h>
#import <CoreML/CoreML.h>

static NSDictionary *failure(NSString *code, NSError *error) {
    return @{ @"ok": @NO, @"error": code, @"details": error.localizedDescription ?: @"" };
}

static CGImageRef loadImage(NSDictionary *request) CF_RETURNS_RETAINED {
    if (![request[@"input"] isKindOfClass:NSString.class]) return NULL;
    NSURL *url = [NSURL fileURLWithPath:request[@"input"]];
    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:url.path error:nil];
    if (!attributes || [attributes fileSize] > 64 * 1024 * 1024) return NULL;
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    if (!source) return NULL;
    NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
    double width = [properties[(__bridge NSString *)kCGImagePropertyPixelWidth] doubleValue];
    double height = [properties[(__bridge NSString *)kCGImagePropertyPixelHeight] doubleValue];
    CGImageRef image = width > 0 && height > 0 && width * height <= 64000000 ? CGImageSourceCreateImageAtIndex(source, 0, NULL) : NULL;
    CFRelease(source); return image;
}

static NSDictionary *writeImage(CIImage *image, CGImageRef original, NSDictionary *request) {
    if (![request[@"output"] isKindOfClass:NSString.class]) return failure(@"invalid-output", nil);
    CIContext *context = [CIContext contextWithOptions:@{ kCIContextWorkingColorSpace: NSNull.null, kCIContextUseSoftwareRenderer: @YES }];
    CGColorSpaceRef originalColor = CGImageGetColorSpace(original);
    CGColorSpaceRef color = originalColor && CGColorSpaceGetModel(originalColor) == kCGColorSpaceModelRGB
        ? CGColorSpaceRetain(originalColor) : CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CIFormat format = CGImageGetBitsPerComponent(original) > 8 ? kCIFormatRGBA16 : kCIFormatRGBA8;
    CGImageRef result = [context createCGImage:image fromRect:image.extent format:format colorSpace:color]; CGColorSpaceRelease(color);
    if (!result) return failure(@"image-transform-failed", nil);
    NSURL *url = [NSURL fileURLWithPath:request[@"output"]];
    CGImageDestinationRef destination = CGImageDestinationCreateWithURL((__bridge CFURLRef)url, CFSTR("public.png"), 1, NULL);
    if (!destination) { CGImageRelease(result); return failure(@"image-write-failed", nil); }
    CGImageDestinationAddImage(destination, result, NULL);
    BOOL success = CGImageDestinationFinalize(destination);
    NSDictionary *response = success ? @{ @"ok": @YES, @"width": @(CGImageGetWidth(result)), @"height": @(CGImageGetHeight(result)) }
        : failure(@"image-write-failed", nil);
    CFRelease(destination); CGImageRelease(result); return response;
}

static NSDictionary *recognizeText(CGImageRef image) {
    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = NO;
    if (@available(macOS 13.0, *)) { request.revision = VNRecognizeTextRequestRevision3; request.automaticallyDetectsLanguage = YES; }
    NSError *error = nil;
    NSArray *supported = [request supportedRecognitionLanguagesAndReturnError:&error];
    NSMutableArray *languages = [NSMutableArray array];
    for (NSString *language in @[@"zh-Hans", @"zh-Hant", @"en-US"]) if ([supported containsObject:language]) [languages addObject:language];
    if (languages.count) request.recognitionLanguages = languages;
    if (@available(macOS 14.0, *)) {
        NSDictionary *stages = [request supportedComputeStageDevicesAndReturnError:nil];
        for (VNComputeStage stage in stages) for (id device in stages[stage]) {
            if ([device isKindOfClass:MLCPUComputeDevice.class]) { [request setComputeDevice:device forComputeStage:stage]; break; }
        }
    }
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    if (![handler performRequests:@[request] error:&error]) return failure(@"text-recognition-failed", error);
    NSMutableArray *lines = [NSMutableArray array], *strings = [NSMutableArray array];
    NSUInteger length = 0; __block NSUInteger wordCount = 0;
    for (VNRecognizedTextObservation *observation in request.results) {
        VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
        if (!candidate.string.length) continue;
        length += [candidate.string lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
        if (length > 1024 * 1024 || lines.count >= 10000) return failure(@"recognized-text-too-large", nil);
        CGRect box = observation.boundingBox;
        NSMutableArray *words = [NSMutableArray array];
        [candidate.string enumerateSubstringsInRange:NSMakeRange(0, candidate.string.length) options:NSStringEnumerationByWords
            usingBlock:^(NSString *word, NSRange range, NSRange enclosingRange, BOOL *stop) {
                if (++wordCount > 20000) { *stop = YES; return; }
                VNRectangleObservation *rectangle = [candidate boundingBoxForRange:range error:nil];
                if (rectangle) {
                    CGRect rect = rectangle.boundingBox;
                    [words addObject:@{ @"text": word, @"box": @{ @"x": @(rect.origin.x), @"y": @(1 - CGRectGetMaxY(rect)), @"width": @(rect.size.width), @"height": @(rect.size.height) } }];
                }
            }];
        if (wordCount > 20000) return failure(@"recognized-text-too-large", nil);
        [strings addObject:candidate.string];
        [lines addObject:@{ @"text": candidate.string, @"confidence": @(candidate.confidence), @"words": words,
            @"box": @{ @"x": @(box.origin.x), @"y": @(1 - CGRectGetMaxY(box)), @"width": @(box.size.width), @"height": @(box.size.height) } }];
    }
    return @{ @"ok": @YES, @"text": [strings componentsJoinedByString:@"\n"], @"lines": lines,
        @"engine": [NSString stringWithFormat:@"apple-vision-text-%lu", (unsigned long)request.revision], @"languages": languages };
}

static NSDictionary *cutout(CGImageRef image, NSDictionary *parameters) {
    if (@available(macOS 14.0, *)) {
        VNGenerateForegroundInstanceMaskRequest *request = [[VNGenerateForegroundInstanceMaskRequest alloc] init];
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
        NSError *error = nil;
        if (![handler performRequests:@[request] error:&error]) return failure(@"foreground-segmentation-failed", error);
        VNInstanceMaskObservation *observation = request.results.firstObject;
        if (!observation.allInstances.count) return failure(@"no-foreground", nil);
        CVPixelBufferRef buffer = [observation generateMaskedImageOfInstances:observation.allInstances fromRequestHandler:handler croppedToInstancesExtent:NO error:&error];
        if (!buffer) return failure(@"foreground-mask-failed", error);
        NSDictionary *result = writeImage([CIImage imageWithCVPixelBuffer:buffer], image, parameters);
        CVPixelBufferRelease(buffer); return result;
    }
    return failure(@"background-removal-unavailable", nil);
}

NSDictionary *PasteImageOperation(NSString *command, NSDictionary *request) {
    @try {
        if ([command isEqualToString:@"image-capabilities"]) {
            BOOL background = NO;
            if (@available(macOS 14.0, *)) background = YES;
            return @{ @"ok": @YES, @"textRecognition": @YES, @"backgroundRemoval": @(background) };
        }
        CGImageRef image = loadImage(request);
        if (!image) return failure(@"invalid-image", nil);
        NSDictionary *result;
        if ([command isEqualToString:@"image-ocr"]) result = recognizeText(image);
        else if ([command isEqualToString:@"image-cutout"]) result = cutout(image, request);
        else if ([command isEqualToString:@"image-rotate"]) {
            NSInteger turns = [request[@"turns"] isKindOfClass:NSNumber.class] ? [request[@"turns"] integerValue] : 0;
            if (turns < 1 || turns > 3) result = failure(@"invalid-rotation", nil);
            else {
                int orientations[] = { 1, kCGImagePropertyOrientationRight, kCGImagePropertyOrientationDown, kCGImagePropertyOrientationLeft };
                result = writeImage([[CIImage imageWithCGImage:image] imageByApplyingOrientation:orientations[turns]], image, request);
            }
        } else result = failure(@"unknown-image-command", nil);
        CGImageRelease(image); return result;
    } @catch (NSException *exception) { return failure(@"image-processing-failed", nil); }
}
