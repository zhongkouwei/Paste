#import "stack-events.h"
#import <dispatch/dispatch.h>
#import <unistd.h>
#import <fcntl.h>
#import <signal.h>
#import <errno.h>

const int64_t PasteSyntheticKeyTag = 0x505354535441434B;
BOOL PasteStackMatchesCommand(CGEventType type, CGEventRef event, NSString *characters) {
    if (type != kCGEventKeyDown || !event || CGEventGetIntegerValueField(event, kCGEventSourceUserData) == PasteSyntheticKeyTag) return NO;
    CGEventFlags flags = CGEventGetFlags(event), modifiers = kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskShift;
    return (flags & modifiers) == kCGEventFlagMaskCommand && [characters.lowercaseString isEqualToString:@"v"];
}
PasteStackDecision PasteStackDecide(CGEventRef event, BOOL eligibleTarget, NSInteger available, BOOL busy) {
    if (!eligibleTarget) return PasteStackPass;
    if (CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat)) return available > 0 || busy ? PasteStackSuppress : PasteStackPass;
    if (available > 0) return PasteStackCapture;
    return busy ? PasteStackSuppress : PasteStackPass;
}

@interface PasteStackEvents : NSObject
@property NSPasteboard *board;
@property NSMutableData *input;
@property BOOL stopping, allowKeyboard, keyboardBlocked, busy, lastTrusted;
@property pid_t ownPID;
@property NSInteger count, version;
@property int64_t epoch, emitted, ack;
@property double parentBeat, lastBeat;
@property CFMachPortRef tap;
@property CFRunLoopSourceRef tapSource;
@property(copy) NSString *keyboardError;
@end
@implementation PasteStackEvents
@end

static BOOL integer(id value, double maximum) {
    return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID()
        && isfinite([value doubleValue]) && [value doubleValue] >= 0 && [value doubleValue] <= maximum && floor([value doubleValue]) == [value doubleValue];
}
static void stop(PasteStackEvents *state) {
    state.stopping = YES;
    if (state.tap) CGEventTapEnable(state.tap, false);
    CFRunLoopStop(CFRunLoopGetMain());
}
static BOOL emit(PasteStackEvents *state, NSDictionary *message) {
    NSMutableData *data = [[NSJSONSerialization dataWithJSONObject:message options:NSJSONWritingSortedKeys error:nil] mutableCopy];
    [data appendBytes:"\n" length:1];
    // Nonblocking, sub-PIPE_BUF frames cannot hold a keyboard callback hostage
    // when the parent has stopped reading. A failed send releases the tap.
    if (!data || data.length > 4096 || write(STDOUT_FILENO, data.bytes, data.length) != (ssize_t)data.length) { stop(state); return NO; }
    return YES;
}
static void releaseTap(PasteStackEvents *state) {
    if (state.tapSource) { CFRunLoopRemoveSource(CFRunLoopGetMain(), state.tapSource, kCFRunLoopCommonModes); CFRelease(state.tapSource); state.tapSource = NULL; }
    if (state.tap) { CGEventTapEnable(state.tap, false); CFMachPortInvalidate(state.tap); CFRelease(state.tap); state.tap = NULL; }
}
static NSDictionary *target(NSRunningApplication *app, pid_t ownPID) {
    NSString *bundle = app.bundleIdentifier;
    if (!app || app.terminated || app.processIdentifier <= 0 || app.processIdentifier == ownPID || !bundle.length || bundle.length > 200
        || [bundle rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-"] invertedSet]].location != NSNotFound
        || !isfinite(app.launchDate.timeIntervalSince1970) || app.launchDate.timeIntervalSince1970 <= 0) return nil;
    return @{ @"pid": @(app.processIdentifier), @"bundleId": bundle, @"launchTime": @(app.launchDate.timeIntervalSince1970) };
}
static CGEventRef keyEvent(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
    PasteStackEvents *state = (__bridge PasteStackEvents *)info;
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        state.keyboardBlocked = YES; CGEventTapEnable(state.tap, false); state.keyboardError = @"keyboard-paused";
        emit(state, @{ @"event": @"keyboard", @"keyboard": @NO, @"error": state.keyboardError }); return event;
    }
    if (state.stopping || !state.epoch) return event;
    NSString *characters = type == kCGEventKeyDown ? [NSEvent eventWithCGEvent:event].charactersIgnoringModifiers : nil;
    if (!PasteStackMatchesCommand(type, event, characters)) return event;
    NSDictionary *destination = target(NSWorkspace.sharedWorkspace.frontmostApplication, state.ownPID);
    int64_t outstanding = state.emitted - state.ack;
    PasteStackDecision decision = PasteStackDecide(event, destination != nil, MAX(0, state.count - outstanding), state.busy || outstanding > 0);
    if (decision == PasteStackPass) return event;
    if (decision == PasteStackSuppress) return NULL;
    if (state.emitted >= 1000000000) { stop(state); return event; }
    state.emitted++;
    return emit(state, @{ @"event": @"paste", @"epoch": @(state.epoch), @"seq": @(state.emitted), @"target": destination }) ? NULL : event;
}
static BOOL enableKeyboard(PasteStackEvents *state) {
    releaseTap(state);
    if (!state.allowKeyboard) { state.keyboardError = @"simulation"; return NO; }
    if (!AXIsProcessTrusted() || !CGPreflightPostEventAccess()) { state.keyboardError = @"accessibility-required"; return NO; }
    state.tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, CGEventMaskBit(kCGEventKeyDown), keyEvent, (__bridge void *)state);
    if (!state.tap) { state.keyboardError = @"keyboard-unavailable"; return NO; }
    state.tapSource = CFMachPortCreateRunLoopSource(NULL, state.tap, 0);
    if (!state.tapSource) { releaseTap(state); state.keyboardError = @"keyboard-unavailable"; return NO; }
    CFRunLoopAddSource(CFRunLoopGetMain(), state.tapSource, kCFRunLoopCommonModes); CGEventTapEnable(state.tap, true);
    state.keyboardError = @""; return YES;
}
static void configure(PasteStackEvents *state, NSData *data) {
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![value isKindOfClass:NSDictionary.class]) { stop(state); return; }
    if ([value[@"stop"] isEqual:@YES]) { stop(state); return; }
    if ([value[@"refresh"] isEqual:@YES]) {
        state.keyboardBlocked = NO;
        BOOL keyboard = enableKeyboard(state);
        emit(state, @{ @"event": @"keyboard", @"keyboard": @(keyboard), @"error": state.keyboardError }); return;
    }
    if (!integer(value[@"epoch"], INT_MAX) || [value[@"epoch"] longLongValue] <= 0 || !integer(value[@"ack"], 1000000000)
        || !integer(value[@"count"], 100000) || CFGetTypeID((__bridge CFTypeRef)(value[@"busy"] ?: NSNull.null)) != CFBooleanGetTypeID()) { stop(state); return; }
    int64_t epoch = [value[@"epoch"] longLongValue], ack = [value[@"ack"] longLongValue];
    if (epoch < state.epoch) return;
    if (epoch != state.epoch) { if (ack) { stop(state); return; } state.epoch = epoch; state.emitted = state.ack = 0; }
    if (ack < state.ack || ack > state.emitted) { stop(state); return; }
    state.ack = ack; state.count = [value[@"count"] integerValue]; state.busy = [value[@"busy"] boolValue]; state.parentBeat = NSProcessInfo.processInfo.systemUptime;
}
int PasteRunStackEvents(NSPasteboard *board, BOOL allowKeyboard, pid_t ownPID) {
    PasteStackEvents *state = [PasteStackEvents new]; state.board = board; state.input = [NSMutableData data]; state.allowKeyboard = allowKeyboard; state.ownPID = ownPID;
    state.parentBeat = state.lastBeat = NSProcessInfo.processInfo.systemUptime; state.version = board.changeCount;
    state.lastTrusted = allowKeyboard && AXIsProcessTrusted();
    signal(SIGPIPE, SIG_IGN); fcntl(STDOUT_FILENO, F_SETFL, fcntl(STDOUT_FILENO, F_GETFL) | O_NONBLOCK);
    fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
    BOOL keyboard = enableKeyboard(state);
    emit(state, @{ @"event": @"ready", @"version": @(state.version), @"keyboard": @(keyboard), @"error": state.keyboardError });
    dispatch_queue_t queue = dispatch_queue_create("com.zhongkouwei.paste-easy.stack-input", DISPATCH_QUEUE_SERIAL);
    dispatch_source_t input = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, queue);
    dispatch_source_set_event_handler(input, ^{
        uint8_t bytes[4096]; ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
        if (count < 0 && (errno == EAGAIN || errno == EINTR)) return;
        NSData *chunk = count > 0 ? [NSData dataWithBytes:bytes length:(NSUInteger)count] : nil;
        CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, ^{
            if (state.stopping) return;
            if (!chunk) { stop(state); return; }
            [state.input appendData:chunk];
            if (state.input.length > 16384) { stop(state); return; }
            while (state.input.length) {
                const uint8_t *start = state.input.bytes, *newline = memchr(start, '\n', state.input.length);
                if (!newline) { if (state.input.length > 4096) stop(state); break; }
                NSUInteger length = newline - start;
                if (!length || length > 4096) { stop(state); break; }
                NSData *line = [state.input subdataWithRange:NSMakeRange(0, length)];
                [state.input replaceBytesInRange:NSMakeRange(0, length + 1) withBytes:NULL length:0]; configure(state, line);
                if (state.stopping) break;
            }
        });
        CFRunLoopWakeUp(CFRunLoopGetMain());
    });
    dispatch_resume(input);
    NSTimer *timer = [NSTimer timerWithTimeInterval:.02 repeats:YES block:^(NSTimer *timer) {
        if (state.stopping) return;
        double now = NSProcessInfo.processInfo.systemUptime;
        if (state.tap && !state.keyboardBlocked && now - state.parentBeat > 2) {
            state.keyboardBlocked = YES; CGEventTapEnable(state.tap, false); state.keyboardError = @"connection-timeout";
            emit(state, @{ @"event": @"keyboard", @"keyboard": @NO, @"error": state.keyboardError });
        }
        BOOL trusted = allowKeyboard && AXIsProcessTrusted();
        if (trusted != state.lastTrusted) {
            state.lastTrusted = trusted; state.keyboardBlocked = NO;
            BOOL enabled = enableKeyboard(state);
            emit(state, @{ @"event": @"keyboard", @"keyboard": @(enabled), @"error": state.keyboardError });
        }
        NSInteger version = board.changeCount;
        if (version != state.version) { state.version = version; emit(state, @{ @"event": @"clipboard", @"version": @(version) }); }
        if (now - state.lastBeat >= .5) { state.lastBeat = now; emit(state, @{ @"event": @"heartbeat" }); }
    }];
    [NSRunLoop.mainRunLoop addTimer:timer forMode:NSRunLoopCommonModes];
    if (!state.stopping) CFRunLoopRun();
    state.stopping = YES; dispatch_source_cancel(input); [timer invalidate]; releaseTap(state); return 0;
}
