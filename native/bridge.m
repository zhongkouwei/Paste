#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import "images.h"

static void output(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
    if (data) puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
}

static void frontmost(void) {
    NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!app) { output(@{}); return; }
    NSMutableDictionary *result = [@{ @"pid": @(app.processIdentifier), @"bundleId": app.bundleIdentifier ?: @"", @"name": app.localizedName ?: @"", @"launchTime": @(app.launchDate.timeIntervalSince1970) } mutableCopy];
    if (app.bundleURL) {
        NSImage *icon = [NSWorkspace.sharedWorkspace iconForFile:app.bundleURL.path];
        icon.size = NSMakeSize(64, 64);
        NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:icon.TIFFRepresentation];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (png) result[@"icon"] = [@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]];
    }
    AXUIElementRef element = AXUIElementCreateApplication(app.processIdentifier);
    CFTypeRef window = NULL;
    if (AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute, &window) == kAXErrorSuccess && window) {
        CFTypeRef position = NULL;
        if (AXUIElementCopyAttributeValue((AXUIElementRef)window, kAXPositionAttribute, &position) == kAXErrorSuccess && position) {
            CGPoint point;
            if (AXValueGetValue((AXValueRef)position, kAXValueCGPointType, &point)) result[@"windowPoint"] = @{ @"x": @(point.x), @"y": @(point.y) };
            CFRelease(position);
        }
        CFRelease(window);
    }
    CFRelease(element);
    output(result);
}

static BOOL validBundleID(id value) {
    return [value isKindOfClass:NSString.class] && [value length] > 0 && [value length] <= 200
        && [value rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-"] invertedSet]].location == NSNotFound;
}

static NSDictionary *applicationInfo(NSURL *url) {
    NSNumber *directory = nil; [url getResourceValue:&directory forKey:NSURLIsDirectoryKey error:nil];
    if (!directory.boolValue || ![url.pathExtension.lowercaseString isEqualToString:@"app"]) return nil;
    NSBundle *bundle = [NSBundle bundleWithURL:url];
    NSString *identifier = bundle.bundleIdentifier;
    if (!validBundleID(identifier) || ![bundle.infoDictionary[@"CFBundlePackageType"] isEqual:@"APPL"]) return nil;
    id name = bundle.localizedInfoDictionary[@"CFBundleDisplayName"] ?: bundle.infoDictionary[@"CFBundleDisplayName"]
        ?: bundle.localizedInfoDictionary[@"CFBundleName"] ?: bundle.infoDictionary[@"CFBundleName"];
    if (![name isKindOfClass:NSString.class] || ![name length] || [name length] > 1000) name = [NSFileManager.defaultManager displayNameAtPath:url.path];
    NSMutableDictionary *result = [@{ @"bundleId": identifier, @"name": name ?: identifier, @"available": @YES } mutableCopy];
    NSImage *icon = [NSWorkspace.sharedWorkspace iconForFile:url.path];
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:64 pixelsHigh:64 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:256 bitsPerPixel:32];
    if (icon && bitmap) {
        [NSGraphicsContext saveGraphicsState]; NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
        [icon drawInRect:NSMakeRect(0, 0, 64, 64) fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1];
        [NSGraphicsContext restoreGraphicsState];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (png.length && png.length <= 32768) result[@"icon"] = [@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]];
    }
    return result;
}

static NSDictionary *applicationsInfo(NSDictionary *request) {
    BOOL selecting = request[@"paths"] != nil;
    NSArray *values = request[selecting ? @"paths" : @"identifiers"];
    if (![values isKindOfClass:NSArray.class] || values.count > 32 || (selecting && request[@"identifiers"])) return @{ @"ok": @NO, @"error": @"invalid-applications" };
    NSMutableArray *applications = [NSMutableArray array];
    for (id value in values) {
        NSURL *url = nil;
        if (selecting) {
            if (![value isKindOfClass:NSString.class] || ![value isAbsolutePath] || [value length] > 4096 || [value rangeOfString:@"\0"].location != NSNotFound) return @{ @"ok": @NO, @"error": @"invalid-application" };
            url = [[NSURL fileURLWithPath:value] URLByResolvingSymlinksInPath];
        } else {
            if (!validBundleID(value)) return @{ @"ok": @NO, @"error": @"invalid-applications" };
            url = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:value];
        }
        NSDictionary *info = url ? applicationInfo(url) : nil;
        if (selecting && !info) return @{ @"ok": @NO, @"error": @"invalid-application" };
        if (!selecting && ![info[@"bundleId"] isEqual:value]) info = nil;
        [applications addObject:info ?: @{ @"bundleId": value, @"name": value, @"available": @NO }];
    }
    return @{ @"ok": @YES, @"applications": applications };
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *command = argc > 1 ? @(argv[1]) : @"";
        if ([command isEqualToString:@"frontmost"]) { frontmost(); return 0; }
        if ([command isEqualToString:@"application-info"]) {
            @try {
                NSData *input = [NSFileHandle.fileHandleWithStandardInput readDataToEndOfFile];
                id request = input.length <= 256 * 1024 ? [NSJSONSerialization JSONObjectWithData:input options:0 error:nil] : nil;
                NSDictionary *result = [request isKindOfClass:NSDictionary.class] ? applicationsInfo(request) : @{ @"ok": @NO, @"error": @"invalid-applications" };
                output(result); return [result[@"ok"] boolValue] ? 0 : 1;
            } @catch (NSException *exception) { output(@{ @"ok": @NO, @"error": @"application-info-failed" }); return 1; }
        }
        if ([command hasPrefix:@"image-"]) {
            NSDictionary *request = @{};
            if (![command isEqualToString:@"image-capabilities"]) {
                NSData *input = [NSFileHandle.fileHandleWithStandardInput readDataToEndOfFile];
                request = input.length < 65536 ? [NSJSONSerialization JSONObjectWithData:input options:0 error:nil] : nil;
                if (![request isKindOfClass:NSDictionary.class]) { output(@{ @"ok": @NO, @"error": @"invalid-image-request" }); return 1; }
            }
            NSDictionary *result = PasteImageOperation(command, request); output(result); return [result[@"ok"] boolValue] ? 0 : 1;
        }
        if ([command isEqualToString:@"permission"]) { output(@{ @"accessibility": @(AXIsProcessTrusted()) }); return 0; }
        if ([command isEqualToString:@"change-count"]) { output(@{ @"count": @(NSPasteboard.generalPasteboard.changeCount) }); return 0; }
        if ([command isEqualToString:@"read-files"]) {
            NSArray<NSURL *> *urls = [NSPasteboard.generalPasteboard readObjectsForClasses:@[NSURL.class] options:@{ NSPasteboardURLReadingFileURLsOnlyKey: @YES }];
            NSMutableArray *files = [NSMutableArray array];
            for (NSURL *url in urls) [files addObject:url.absoluteString];
            output(@{ @"files": files }); return 0;
        }
        if ([command isEqualToString:@"write-files"]) {
            NSData *input = [NSFileHandle.fileHandleWithStandardInput readDataToEndOfFile];
            NSDictionary *request = input.length <= 4 * 1024 * 1024 ? [NSJSONSerialization JSONObjectWithData:input options:0 error:nil] : nil;
            NSArray *values = [request isKindOfClass:NSDictionary.class] ? request[@"files"] : nil;
            if (![values isKindOfClass:NSArray.class] || !values.count || values.count > 10000) { output(@{ @"ok": @NO, @"error": @"invalid-files" }); return 1; }
            NSMutableArray<NSURL *> *urls = [NSMutableArray array];
            for (id value in values) {
                NSURL *url = [value isKindOfClass:NSString.class] ? [NSURL URLWithString:value] : nil;
                if (!url.isFileURL || (url.host.length && ![url.host isEqualToString:@"localhost"])) { output(@{ @"ok": @NO, @"error": @"invalid-file-url" }); return 1; }
                [urls addObject:url];
            }
            [NSPasteboard.generalPasteboard clearContents];
            output(@{ @"ok": @([NSPasteboard.generalPasteboard writeObjects:urls]) }); return 0;
        }
        if ([command isEqualToString:@"paste"]) {
            if (!AXIsProcessTrusted()) { output(@{ @"ok": @NO, @"error": @"accessibility-required" }); return 0; }
            int pid = argc > 2 ? [@(argv[2]) intValue] : 0;
            NSRunningApplication *app = pid > 0 ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
            if (!app || app.terminated) { output(@{ @"ok": @NO, @"error": @"target-unavailable" }); return 0; }
            NSString *expectedBundle = argc > 3 ? @(argv[3]) : nil;
            double expectedLaunchTime = argc > 4 ? [@(argv[4]) doubleValue] : 0;
            if (!expectedBundle || ![app.bundleIdentifier isEqualToString:expectedBundle] || expectedLaunchTime <= 0
                || fabs(app.launchDate.timeIntervalSince1970 - expectedLaunchTime) > .001) {
                output(@{ @"ok": @NO, @"error": @"target-changed" }); return 0;
            }
            if (![app activateWithOptions:0]) { output(@{ @"ok": @NO, @"error": @"activation-failed" }); return 0; }
            NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:1];
            while (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid && deadline.timeIntervalSinceNow > 0) [NSThread sleepForTimeInterval:.02];
            if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid) { output(@{ @"ok": @NO, @"error": @"activation-failed" }); return 0; }
            [NSThread sleepForTimeInterval:.08];
            if (app.terminated || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid) {
                output(@{ @"ok": @NO, @"error": @"target-changed" }); return 0;
            }
            CGEventRef down = CGEventCreateKeyboardEvent(NULL, 9, true), up = CGEventCreateKeyboardEvent(NULL, 9, false);
            CGEventSetFlags(down, kCGEventFlagMaskCommand); CGEventSetFlags(up, kCGEventFlagMaskCommand);
            CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, up);
            CFRelease(down); CFRelease(up); output(@{ @"ok": @YES }); return 0;
        }
        output(@{ @"ok": @NO, @"error": @"unknown-command" }); return 1;
    }
}
