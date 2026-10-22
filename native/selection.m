#import "selection.h"
#import <ImageIO/ImageIO.h>
static BOOL string(id value) { return [value isKindOfClass:NSString.class]; }
NSDictionary *PasteComposeSelection(NSArray *segments) {
    if (![segments isKindOfClass:NSArray.class] || !segments.count || segments.count > 10000) return @{ @"ok": @NO, @"error": @"invalid-selection" };
    NSMutableAttributedString *combined = [[NSMutableAttributedString alloc] initWithString:@""];
    NSUInteger inputBytes = 0; BOOL first = YES;
    for (id value in segments) {
        if (![value isKindOfClass:NSDictionary.class]) return @{ @"ok": @NO, @"error": @"invalid-segment" };
        NSAttributedString *part;
        if (value[@"image"]) {
            if (!string(value[@"image"]) || [value[@"image"] length] > 8 * 1024 * 1024) return @{ @"ok": @NO, @"error": @"invalid-image" };
            NSData *data = [[NSData alloc] initWithBase64EncodedString:value[@"image"] options:0];
            const unsigned char png[] = {137, 80, 78, 71, 13, 10, 26, 10};
            CGImageSourceRef source = data.length >= 8 && memcmp(data.bytes, png, 8) == 0 ? CGImageSourceCreateWithData((__bridge CFDataRef)data, (__bridge CFDictionaryRef)@{ (__bridge NSString *)kCGImageSourceShouldCache: @NO }) : NULL;
            NSDictionary *properties = source ? CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL)) : nil;
            double width = [properties[(__bridge NSString *)kCGImagePropertyPixelWidth] doubleValue], height = [properties[(__bridge NSString *)kCGImagePropertyPixelHeight] doubleValue];
            if (!source || !isfinite(width) || !isfinite(height) || width <= 0 || height <= 0 || width * height > 64000000) { if (source) CFRelease(source); return @{ @"ok": @NO, @"error": @"invalid-image" }; }
            CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, (__bridge CFDictionaryRef)@{ (__bridge NSString *)kCGImageSourceShouldCache: @NO }); CFRelease(source);
            if (!image) return @{ @"ok": @NO, @"error": @"invalid-image" }; CFRelease(image);
            NSFileWrapper *file = [[NSFileWrapper alloc] initRegularFileWithContents:data]; file.preferredFilename = [NSString stringWithFormat:@"Image-%lu.png", (unsigned long)combined.length];
            part = [NSAttributedString attributedStringWithAttachment:[[NSTextAttachment alloc] initWithFileWrapper:file]];
            inputBytes += [value[@"image"] length];
        } else {
            if (!string(value[@"text"]) || !string(value[@"html"] ?: @"")) return @{ @"ok": @NO, @"error": @"invalid-text" };
            NSString *text = value[@"text"], *html = value[@"html"] ?: @"";
            inputBytes += [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] + [html lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
            if (inputBytes > 32 * 1024 * 1024) return @{ @"ok": @NO, @"error": @"selection-too-large" };
            if (html.length) {
                // Only the isolated renderer's resource-free, inline HTML reaches
                // AppKit. Never import an untrusted original document here.
                NSString *document = [@"<meta charset=\"utf-8\">" stringByAppendingString:html];
                part = [[NSAttributedString alloc] initWithData:[document dataUsingEncoding:NSUTF8StringEncoding]
                    options:@{ NSDocumentTypeDocumentAttribute: NSHTMLTextDocumentType, NSCharacterEncodingDocumentAttribute: @(NSUTF8StringEncoding) } documentAttributes:nil error:nil];
                if (!part) return @{ @"ok": @NO, @"error": @"rich-import-failed" };
                if ([part.string isEqualToString:[text stringByAppendingString:@"\n"]]) part = [part attributedSubstringFromRange:NSMakeRange(0, part.length - 1)];
            } else part = [[NSAttributedString alloc] initWithString:text];
        }
        if (inputBytes > 32 * 1024 * 1024 || combined.length + part.length > 16 * 1024 * 1024) return @{ @"ok": @NO, @"error": @"selection-too-large" };
        if (!first) [combined appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n"]]; first = NO;
        [combined appendAttributedString:part];
    }
    __block NSUInteger attachments = 0;
    [combined enumerateAttribute:NSAttachmentAttributeName inRange:NSMakeRange(0, combined.length) options:0 usingBlock:^(id value, NSRange range, BOOL *stop) { if (value) attachments += range.length; }];
    NSData *data = attachments ? [combined RTFDFromRange:NSMakeRange(0, combined.length) documentAttributes:@{}]
        : [combined RTFFromRange:NSMakeRange(0, combined.length) documentAttributes:@{}];
    if (!data || data.length > (attachments ? 64 : 32) * 1024 * 1024) return @{ @"ok": @NO, @"error": @"rich-export-failed" };
    if (attachments) return @{ @"ok": @YES, @"attachments": @(attachments), @"rtfd": [data base64EncodedStringWithOptions:0] };
    NSString *rtf = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return rtf ? @{ @"ok": @YES, @"attachments": @0, @"rtf": rtf } : @{ @"ok": @NO, @"error": @"rich-encoding" };
}
