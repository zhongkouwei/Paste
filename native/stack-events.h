#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>

extern const int64_t PasteSyntheticKeyTag;
typedef NS_ENUM(NSInteger, PasteStackDecision) { PasteStackPass, PasteStackCapture, PasteStackSuppress };
BOOL PasteStackMatchesCommand(CGEventType type, CGEventRef event, NSString *characters);
PasteStackDecision PasteStackDecide(CGEventRef event, BOOL eligibleTarget, NSInteger available, BOOL busy);
int PasteRunStackEvents(NSPasteboard *board, BOOL allowKeyboard, pid_t ownPID);
