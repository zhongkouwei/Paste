#import "../../native/pasteboard.h"

static void require(BOOL value, const char *message) {
    if (!value) { fprintf(stderr, "%s\n", message); exit(1); }
}
static NSDictionary *writeFixture(NSPasteboard *board, NSString *token) {
    NSInteger before = board.changeCount;
    NSPasteboardItem *item = [NSPasteboardItem new];
    [item setString:@"Synthetic A 中文" forType:NSPasteboardTypeString];
    [item setString:@"<b>Synthetic A 中文</b>" forType:NSPasteboardTypeHTML];
    [item setData:[@"{\\rtf1 synthetic}" dataUsingEncoding:NSUTF8StringEncoding] forType:NSPasteboardTypeRTF];
    [item setData:[token dataUsingEncoding:NSUTF8StringEncoding] forType:PasteWriteIDType];
    [board clearContents]; require([board writeObjects:@[item]], "write fixture failed");
    require(board.changeCount == before + 1, "atomic multi-format write must claim ownership once");
    return @{ @"version": @(before + 1), @"token": token };
}
int main(void) {
    @autoreleasepool {
        // This executable never accesses the general pasteboard or posts keys.
        NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];
        NSString *token = NSUUID.UUID.UUIDString;
        __block int prepared = 0, sent = 0;
        NSDictionary *(^prepare)(void) = ^{ prepared++; return @{ @"ok": @YES }; };
        NSDictionary *(^send)(void) = ^{ sent++; return @{ @"ok": @YES }; };
        for (int n = 0; n < 20; n++) {
            NSDictionary *lease = writeFixture(board, token);
            require([PasteCheckOwnership(board, lease)[@"ok"] boolValue], "fresh rich lease rejected");
            require([PasteGuardedEvent(board, lease, prepare, send)[@"ok"] boolValue], "normal delivery failed");
            require([[board stringForType:NSPasteboardTypeString] isEqual:@"Synthetic A 中文"], "guard changed text");
            require([[board stringForType:NSPasteboardTypeHTML] isEqual:@"<b>Synthetic A 中文</b>"], "guard changed HTML");
            NSDictionary *wrong = @{ @"version": lease[@"version"], @"token": NSUUID.UUID.UUIDString };
            require(![PasteCheckOwnership(board, wrong)[@"ok"] boolValue], "wrong marker accepted");
            int oldPrepared = prepared, oldSent = sent;
            writeFixture(board, token); // Cloned marker still cannot reuse an older version.
            require(![PasteGuardedEvent(board, lease, prepare, send)[@"ok"] boolValue], "foreign version accepted");
            require(prepared == oldPrepared && sent == oldSent, "stale copy reached activation");
            lease = writeFixture(board, token);
            NSDictionary *result = PasteGuardedEvent(board, lease, ^{
                [board clearContents]; [board setString:@"Later foreign B" forType:NSPasteboardTypeString];
                return @{ @"ok": @YES };
            }, send);
            require([result[@"error"] isEqual:@"clipboard-changed"], "activation-time replacement not detected");
            require(sent == oldSent, "replacement reached event delivery");
            require([[board stringForType:NSPasteboardTypeString] isEqual:@"Later foreign B"], "foreign copy overwritten");
            lease = writeFixture(board, token);
            result = PasteGuardedEvent(board, lease, ^{ return @{ @"ok": @NO, @"error": @"activation-failed" }; }, send);
            require([result[@"error"] isEqual:@"activation-failed"] && sent == oldSent, "activation failure reached event delivery");
        }
        NSArray<NSURL *> *urls = @[[NSURL fileURLWithPath:@"/tmp/synthetic a.txt"], [NSURL fileURLWithPath:@"/tmp/中文.txt"]];
        require(PasteWriteFiles(board, urls, nil), "unmarked URL write failed");
        NSArray *originalTypes = [board.pasteboardItems valueForKey:@"types"];
        NSArray *originalRead = [board readObjectsForClasses:@[NSURL.class] options:@{ NSPasteboardURLReadingFileURLsOnlyKey: @YES }];
        NSInteger before = board.changeCount;
        require(PasteWriteFiles(board, urls, token), "marked URL write failed");
        require(board.changeCount == before + 1, "file write claimed ownership multiple times");
        require(board.pasteboardItems.count == 2, "marker became phantom file item");
        require([PasteCheckOwnership(board, @{ @"version": @(before + 1), @"token": token })[@"ok"] boolValue], "file lease rejected");
        require([[board readObjectsForClasses:@[NSURL.class] options:@{ NSPasteboardURLReadingFileURLsOnlyKey: @YES }] isEqual:originalRead], "URL serialization/order changed");
        for (NSUInteger n = 0; n < 2; n++) {
            NSMutableSet *types = [NSMutableSet setWithArray:board.pasteboardItems[n].types]; [types removeObject:PasteWriteIDType];
            require([types isEqualToSet:[NSSet setWithArray:originalTypes[n]]], "native URL formats changed");
        }
        require([board.pasteboardItems[1] dataForType:PasteWriteIDType] == nil, "marker repeated on later file");
        before = board.changeCount;
        require(!PasteWriteFiles(board, urls, @"bad"), "invalid file marker accepted"); require(board.changeCount == before, "invalid input cleared board");
        for (id lease in @[@{}, @{ @"version": @YES, @"token": token }, @{ @"version": @1.5, @"token": token }, @{ @"version": @(-1), @"token": token }, @{ @"version": @1, @"token": @"bad" }]) {
            require(!PasteValidLease(lease), "malformed lease accepted");
        }
        [board releaseGlobally];
        puts("private pasteboard: 20 normal/race cycles, URL formats/order and input validation passed; no general clipboard or real keys");
    }
}
