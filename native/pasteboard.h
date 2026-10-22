#import <Cocoa/Cocoa.h>

extern NSPasteboardType const PasteWriteIDType;
BOOL PasteValidWriteID(id value);
BOOL PasteValidLease(id value);
NSDictionary *PasteCheckOwnership(NSPasteboard *board, NSDictionary *lease);
NSDictionary *PasteGuardedEvent(NSPasteboard *board, NSDictionary *lease, NSDictionary *(^prepare)(void), NSDictionary *(^send)(void));
BOOL PasteWriteFiles(NSPasteboard *board, NSArray<NSURL *> *urls, NSString *writeID);
