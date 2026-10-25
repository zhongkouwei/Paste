#import <Cocoa/Cocoa.h>

static const NSUInteger MaxBytes = 64 * 1024 * 1024;
static void require(BOOL condition, NSString *message) { if (!condition) @throw [NSException exceptionWithName:@"ClipboardSnapshot" reason:message userInfo:nil]; }

static NSArray *snapshot(NSPasteboard *board) {
    NSInteger version = board.changeCount;
    NSArray *items = board.pasteboardItems;
    require(items.count <= 10000 && (items.count || !board.types.count), @"Clipboard items cannot be fully materialized.");
    NSMutableArray *result = [NSMutableArray array]; NSUInteger size = 0;
    for (NSPasteboardItem *item in items) {
        NSArray *types = [item.types sortedArrayUsingSelector:@selector(compare:)];
        require(types.count > 0 && types.count <= 256, @"Unsupported clipboard format count.");
        NSMutableDictionary *formats = [NSMutableDictionary dictionary];
        for (NSString *type in types) {
            require(type.length > 0 && type.length <= 4096, @"Unsupported clipboard format identifier.");
            NSData *data = [item dataForType:type];
            NSUInteger identifierBytes = [type lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
            require(data != nil && identifierBytes <= MaxBytes - size && data.length <= MaxBytes - size - identifierBytes, @"Clipboard data unavailable or snapshot limit exceeded.");
            size += data.length + identifierBytes; formats[type] = [data base64EncodedStringWithOptions:0];
        }
        require([[item.types sortedArrayUsingSelector:@selector(compare:)] isEqual:types], @"Clipboard formats changed during snapshot.");
        [result addObject:formats];
    }
    require(board.changeCount == version, @"Clipboard changed during snapshot.");
    return result;
}

static NSArray<NSPasteboardItem *> *decode(id saved) {
    require([saved isKindOfClass:NSArray.class] && [saved count] <= 10000, @"Invalid clipboard snapshot.");
    NSMutableArray *items = [NSMutableArray array]; NSUInteger size = 0;
    for (id formats in saved) {
        require([formats isKindOfClass:NSDictionary.class] && [formats count] > 0 && [formats count] <= 256, @"Invalid clipboard snapshot formats.");
        NSPasteboardItem *item = [NSPasteboardItem new];
        for (id type in formats) {
            id encoded = formats[type];
            require([type isKindOfClass:NSString.class] && [type length] > 0 && [type length] <= 4096
                && [encoded isKindOfClass:NSString.class] && [encoded length] <= ((MaxBytes - size + 2) / 3) * 4, @"Invalid clipboard snapshot data.");
            NSData *data = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
            NSUInteger identifierBytes = [type lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
            require(data != nil && identifierBytes <= MaxBytes - size && data.length <= MaxBytes - size - identifierBytes
                && [[data base64EncodedStringWithOptions:0] isEqual:encoded] && [item setData:data forType:type], @"Invalid clipboard snapshot bytes.");
            size += data.length + identifierBytes;
        }
        [items addObject:item];
    }
    return items;
}

static void restore(NSPasteboard *board, id saved) {
    // Decode every item before clearing; malformed input must leave the board intact.
    NSArray *items = decode(saved);
    [board clearContents];
    require(!items.count || [board writeObjects:items], @"Clipboard restore write failed.");
    require([snapshot(board) isEqual:saved], @"Clipboard restore verification failed.");
}

static void selfTest(void) {
    NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];
    @try {
        const unsigned char bytes[] = { 0, 255, 13, 10, 128, 0 };
        NSData *binary = [NSData dataWithBytes:bytes length:sizeof(bytes)];
        NSArray *expected = @[
            @{ @"public.file-url": [[@"file:///tmp/synthetic%20one.txt" dataUsingEncoding:NSUTF8StringEncoding] base64EncodedStringWithOptions:0],
               @"org.paste-easy.private-binary": [binary base64EncodedStringWithOptions:0], @"org.paste-easy.empty": @"" },
            @{ @"public.file-url": [[@"file:///tmp/synthetic-two.txt" dataUsingEncoding:NSUTF8StringEncoding] base64EncodedStringWithOptions:0],
               @"public.utf8-plain-text": [[@"Synthetic 中文\nsecond" dataUsingEncoding:NSUTF8StringEncoding] base64EncodedStringWithOptions:0] }
        ];
        restore(board, expected);
        NSArray *saved = snapshot(board);
        NSArray *urls = [board readObjectsForClasses:@[NSURL.class] options:@{ NSPasteboardURLReadingFileURLsOnlyKey: @YES }];
        require(urls.count == 2, @"Synthetic file URLs unavailable.");
        [board clearContents]; require([board writeObjects:urls], @"URL-only reproduction failed.");
        require(![snapshot(board) isEqual:saved], @"URL-only restore unexpectedly preserved extra native formats.");
        restore(board, saved);
        [board clearContents]; [board setString:@"Synthetic replacement" forType:NSPasteboardTypeString];
        restore(board, saved); require([snapshot(board) isEqual:expected], @"Multi-item round trip lost data.");
        for (id invalid in @[@{}, @[@{}], @[@{ @"invalid": @"%%%" }], @[@{ @"invalid": @"YR==" }], @[@{ @"invalid": @1 }], @[@{ @"": @"" }],
                            @[@{ @"org.paste-easy.valid": @"YQ==" }, @{ @"invalid": @"%%%" }]]) {
            NSInteger version = board.changeCount; BOOL rejected = NO;
            @try { restore(board, invalid); } @catch (NSException *exception) { rejected = YES; }
            require(rejected && board.changeCount == version && [snapshot(board) isEqual:saved], @"Invalid restore modified the clipboard.");
        }
        restore(board, @[]); require(snapshot(board).count == 0, @"Empty snapshot restore failed.");
        puts("PRIVATE pasteboard: ordered items, file URLs plus custom/binary/empty formats, URL-only loss reproduced, exact bytes, malformed restore preflight and empty restore passed; no general clipboard access");
    } @finally { [board releaseGlobally]; }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        @try {
            NSString *command = argc == 2 ? @(argv[1]) : @"";
            if ([command isEqualToString:@"--self-test"]) { selfTest(); return 0; }
            require([command isEqualToString:@"snapshot"] || [command isEqualToString:@"restore"], @"Expected snapshot, restore or --self-test.");
            if ([command isEqualToString:@"snapshot"]) {
                NSData *data = [NSJSONSerialization dataWithJSONObject:snapshot(NSPasteboard.generalPasteboard) options:NSJSONWritingSortedKeys error:nil];
                require(data != nil && data.length <= 96 * 1024 * 1024, @"Clipboard snapshot encoding failed or output limit exceeded.");
                [NSFileHandle.fileHandleWithStandardOutput writeData:data];
            } else {
                NSMutableData *input = [NSMutableData data];
                for (;;) {
                    NSData *chunk = [NSFileHandle.fileHandleWithStandardInput readDataOfLength:65536]; if (!chunk.length) break;
                    require(input.length + chunk.length <= 96 * 1024 * 1024, @"Clipboard snapshot input limit exceeded."); [input appendData:chunk];
                }
                id saved = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
                restore(NSPasteboard.generalPasteboard, saved); puts("Clipboard restored and all native item formats verified.");
            }
            return 0;
        } @catch (NSException *exception) { fprintf(stderr, "%s\n", exception.reason.UTF8String); return 1; }
    }
}
