#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>

static void output(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
    if (data) puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
}

static void frontmost(void) {
    NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!app) { output(@{}); return; }
    NSMutableDictionary *result = [@{ @"pid": @(app.processIdentifier), @"bundleId": app.bundleIdentifier ?: @"", @"name": app.localizedName ?: @"" } mutableCopy];
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

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *command = argc > 1 ? @(argv[1]) : @"";
        if ([command isEqualToString:@"frontmost"]) { frontmost(); return 0; }
        if ([command isEqualToString:@"permission"]) { output(@{ @"accessibility": @(AXIsProcessTrusted()) }); return 0; }
        if ([command isEqualToString:@"paste"]) {
            if (!AXIsProcessTrusted()) { output(@{ @"ok": @NO, @"error": @"accessibility-required" }); return 0; }
            int pid = argc > 2 ? [@(argv[2]) intValue] : 0;
            NSRunningApplication *app = pid > 0 ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
            if (!app || app.terminated) { output(@{ @"ok": @NO, @"error": @"target-unavailable" }); return 0; }
            if (![app activateWithOptions:0]) { output(@{ @"ok": @NO, @"error": @"activation-failed" }); return 0; }
            NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:1];
            while (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid && deadline.timeIntervalSinceNow > 0) [NSThread sleepForTimeInterval:.02];
            if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid) { output(@{ @"ok": @NO, @"error": @"activation-failed" }); return 0; }
            [NSThread sleepForTimeInterval:.08];
            CGEventRef down = CGEventCreateKeyboardEvent(NULL, 9, true), up = CGEventCreateKeyboardEvent(NULL, 9, false);
            CGEventSetFlags(down, kCGEventFlagMaskCommand); CGEventSetFlags(up, kCGEventFlagMaskCommand);
            CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, up);
            CFRelease(down); CFRelease(up); output(@{ @"ok": @YES }); return 0;
        }
        output(@{ @"ok": @NO, @"error": @"unknown-command" }); return 1;
    }
}
