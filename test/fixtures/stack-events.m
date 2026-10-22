#import "../../native/stack-events.h"
#import <unistd.h>
#import <assert.h>
int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc > 1 && strcmp(argv[1], "policy") == 0) {
            CGEventRef event = CGEventCreateKeyboardEvent(NULL, 9, true);
            CGEventSetFlags(event, kCGEventFlagMaskCommand);
            assert(PasteStackMatchesCommand(kCGEventKeyDown, event, @"v"));
            assert(PasteStackMatchesCommand(kCGEventKeyDown, event, @"V"));
            assert(!PasteStackMatchesCommand(kCGEventKeyUp, event, @"v"));
            assert(!PasteStackMatchesCommand(kCGEventKeyDown, event, @"c"));
            CGEventSetIntegerValueField(event, kCGEventSourceUserData, PasteSyntheticKeyTag);
            assert(!PasteStackMatchesCommand(kCGEventKeyDown, event, @"v"));
            CGEventSetIntegerValueField(event, kCGEventSourceUserData, 0);
            for (int flag = 0; flag < 3; flag++) {
                CGEventFlags extra[] = {kCGEventFlagMaskControl, kCGEventFlagMaskAlternate, kCGEventFlagMaskShift};
                CGEventSetFlags(event, kCGEventFlagMaskCommand | extra[flag]);
                assert(!PasteStackMatchesCommand(kCGEventKeyDown, event, @"v"));
            }
            assert(PasteStackDecide(event, NO, 3, YES) == PasteStackPass);
            assert(PasteStackDecide(event, YES, 3, NO) == PasteStackCapture);
            assert(PasteStackDecide(event, YES, 0, YES) == PasteStackSuppress);
            assert(PasteStackDecide(event, YES, 0, NO) == PasteStackPass);
            CGEventSetIntegerValueField(event, kCGKeyboardEventAutorepeat, 1);
            assert(PasteStackDecide(event, YES, 3, NO) == PasteStackSuppress);
            assert(PasteStackDecide(event, YES, 0, NO) == PasteStackPass);
            CFRelease(event); puts("policy passed without posting events or registering a tap"); return 0;
        }
        NSPasteboard *board = [NSPasteboard pasteboardWithName:[@"paste-stack-private-" stringByAppendingString:NSProcessInfo.processInfo.globallyUniqueString]];
        NSTimer *writer = [NSTimer timerWithTimeInterval:.1 repeats:NO block:^(NSTimer *timer) { [board clearContents]; [board setString:@"PRIVATE Stack fixture" forType:NSPasteboardTypeString]; }];
        [NSRunLoop.mainRunLoop addTimer:writer forMode:NSRunLoopCommonModes];
        int result = PasteRunStackEvents(board, NO, getpid());
        [writer invalidate]; [board releaseGlobally]; return result;
    }
}
