#import <Cocoa/Cocoa.h>

int main(void) {
    @autoreleasepool {
        NSData *data = [NSFileHandle.fileHandleWithStandardInput readDataToEndOfFile];
        NSError *error = nil;
        NSAttributedString *text = [[NSAttributedString alloc] initWithData:data options:@{NSDocumentTypeDocumentAttribute:NSRTFTextDocumentType} documentAttributes:nil error:&error];
        if (!text || error) return 1;
        NSMutableArray *colors = [NSMutableArray array];
        [text enumerateAttribute:NSForegroundColorAttributeName inRange:NSMakeRange(0, text.length) options:0 usingBlock:^(NSColor *color, NSRange range, BOOL *stop) {
            NSColor *rgb = [color colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
            if (rgb) [colors addObject:@[@(rgb.redComponent * 255), @(rgb.greenComponent * 255), @(rgb.blueComponent * 255), @(rgb.alphaComponent)]];
        }];
        NSData *output = [NSJSONSerialization dataWithJSONObject:@{ @"text":text.string, @"colors":colors } options:0 error:nil];
        [NSFileHandle.fileHandleWithStandardOutput writeData:output];
    }
    return 0;
}
