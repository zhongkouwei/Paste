#import "../../native/selection.h"
static void require(BOOL value, const char *message) { if (!value) { fprintf(stderr, "%s\n", message); exit(1); } }
static NSData *png(BOOL red) {
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:2 pixelsHigh:1 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    for (NSInteger x = 0; x < 2; x++) { unsigned char *pixel = bitmap.bitmapData + x * 4; pixel[0] = red ? 255 : 0; pixel[1] = 0; pixel[2] = red ? 0 : 255; pixel[3] = 255; }
    return [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}
int main(void) {
    @autoreleasepool {
        NSDictionary *result = PasteComposeSelection(@[@{ @"text": @"Alpha", @"html": @"<b>Alpha</b>" }, @{ @"text": @"中文\n\nBeta", @"html": @"" }]);
        require([result[@"ok"] boolValue] && [result[@"attachments"] intValue] == 0, "rich text composition failed");
        NSAttributedString *text = [[NSAttributedString alloc] initWithRTF:[result[@"rtf"] dataUsingEncoding:NSUTF8StringEncoding] documentAttributes:nil];
        require([text.string isEqual:@"Alpha\n中文\n\nBeta"], "text order or blank lines changed");
        NSFont *font = [text attribute:NSFontAttributeName atIndex:0 effectiveRange:nil];
        require(([NSFontManager.sharedFontManager traitsOfFont:font] & NSBoldFontMask) != 0, "bold lost in RTF");
        NSData *red = png(YES), *blue = png(NO);
        result = PasteComposeSelection(@[@{ @"text": @"Alpha", @"html": @"<b>Alpha</b>" }, @{ @"image": [red base64EncodedStringWithOptions:0] }, @{ @"text": @"Beta" }, @{ @"image": [blue base64EncodedStringWithOptions:0] }]);
        require([result[@"ok"] boolValue] && [result[@"attachments"] intValue] == 2, "multiple image composition failed");
        NSData *rtfd = [[NSData alloc] initWithBase64EncodedString:result[@"rtfd"] options:0];
        NSAttributedString *rich = [[NSAttributedString alloc] initWithRTFD:rtfd documentAttributes:nil];
        require([rich.string isEqual:@"Alpha\n\uFFFC\nBeta\n\uFFFC"], "image or text order lost in RTFD");
        NSMutableArray *images = [NSMutableArray array];
        [rich enumerateAttribute:NSAttachmentAttributeName inRange:NSMakeRange(0, rich.length) options:0 usingBlock:^(NSTextAttachment *value, NSRange range, BOOL *stop) { if (value) [images addObject:value.fileWrapper.regularFileContents]; }];
        require(images.count == 2 && [images[0] isEqual:red] && [images[1] isEqual:blue], "original PNG attachment bytes changed");
        NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];
        [board clearContents]; [board setData:rtfd forType:NSPasteboardTypeRTFD];
        require([[board dataForType:NSPasteboardTypeRTFD] isEqual:rtfd], "private RTFD roundtrip failed"); [board releaseGlobally];
        result = PasteComposeSelection(@[@{ @"text": @"" }, @{ @"text": @"Trailing\n" }]);
        text = [[NSAttributedString alloc] initWithRTF:[result[@"rtf"] dataUsingEncoding:NSUTF8StringEncoding] documentAttributes:nil];
        require([text.string isEqual:@"\nTrailing\n"], "empty segment boundary lost");
        for (id value in @[@[], @[@{}], @[@{ @"image": @"bad" }], @[@{ @"text": @1 }]]) require(![PasteComposeSelection(value)[@"ok"] boolValue], "malformed selection accepted");
        puts("selection: RTF styles/Unicode/empty boundaries and ordered original PNG RTFD attachments passed on PRIVATE pasteboard; no general clipboard or keys");
    }
}
