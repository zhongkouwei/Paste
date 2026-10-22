#import "pasteboard.h"

NSPasteboardType const PasteWriteIDType = @"com.zhongkouwei.paste-easy.write-id";

BOOL PasteValidWriteID(id value) {
    return [value isKindOfClass:NSString.class] && [value length] == 36 && [[NSUUID alloc] initWithUUIDString:value] != nil;
}
BOOL PasteValidLease(id value) {
    if (![value isKindOfClass:NSDictionary.class]) return NO;
    id version = value[@"version"];
    if (![version isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)version) == CFBooleanGetTypeID()) return NO;
    double count = [version doubleValue];
    return isfinite(count) && count >= 0 && count <= 9007199254740991.0 && floor(count) == count && PasteValidWriteID(value[@"token"]);
}
NSDictionary *PasteCheckOwnership(NSPasteboard *board, NSDictionary *lease) {
    if (!PasteValidLease(lease)) return @{ @"ok": @NO, @"error": @"clipboard-unavailable" };
    NSInteger expected = [lease[@"version"] longLongValue];
    // Never fetch foreign payloads. The version is checked before and after
    // reading only our small metadata, not text, files or decoded image data.
    if (board.changeCount != expected) return @{ @"ok": @NO, @"error": @"clipboard-changed" };
    NSData *identity = [board dataForType:PasteWriteIDType];
    NSData *expectedIdentity = [lease[@"token"] dataUsingEncoding:NSUTF8StringEncoding];
    if (![identity isEqualToData:expectedIdentity] || board.changeCount != expected) return @{ @"ok": @NO, @"error": @"clipboard-changed" };
    return @{ @"ok": @YES };
}
NSDictionary *PasteGuardedEvent(NSPasteboard *board, NSDictionary *lease, NSDictionary *(^prepare)(void), NSDictionary *(^send)(void)) {
    NSDictionary *result = PasteCheckOwnership(board, lease);
    if (![result[@"ok"] boolValue]) return result;
    result = prepare();
    if (![result[@"ok"] boolValue]) return result;
    result = PasteCheckOwnership(board, lease);
    return [result[@"ok"] boolValue] ? send() : result;
}

// Delegate the URL's native formats and property lists instead of synthesizing
// file-url strings. The marker belongs to the first actual file, not a new item.
@interface PasteOwnedURL : NSObject <NSPasteboardWriting>
@property(nonatomic, strong) NSURL *url;
@property(nonatomic, strong) NSData *identity;
@end
@implementation PasteOwnedURL
- (NSArray<NSPasteboardType> *)writableTypesForPasteboard:(NSPasteboard *)board {
    return [[self.url writableTypesForPasteboard:board] arrayByAddingObject:PasteWriteIDType];
}
- (id)pasteboardPropertyListForType:(NSPasteboardType)type {
    return [type isEqualToString:PasteWriteIDType] ? self.identity : [self.url pasteboardPropertyListForType:type];
}
- (NSPasteboardWritingOptions)writingOptionsForType:(NSPasteboardType)type pasteboard:(NSPasteboard *)board {
    if ([type isEqualToString:PasteWriteIDType] || ![self.url respondsToSelector:@selector(writingOptionsForType:pasteboard:)]) return 0;
    return [self.url writingOptionsForType:type pasteboard:board];
}
@end
BOOL PasteWriteFiles(NSPasteboard *board, NSArray<NSURL *> *urls, NSString *writeID) {
    if (!urls.count || (writeID && !PasteValidWriteID(writeID))) return NO;
    NSMutableArray *objects = [urls mutableCopy];
    if (writeID) {
        PasteOwnedURL *first = [PasteOwnedURL new]; first.url = urls.firstObject; first.identity = [writeID dataUsingEncoding:NSUTF8StringEncoding];
        objects[0] = first;
    }
    [board clearContents];
    return [board writeObjects:objects];
}
