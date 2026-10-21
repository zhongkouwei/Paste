const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activeRecorders, assertClipboardIsolation } = require('../scripts/clipboard-test-environment');

test('UI preflight detects active reference and product apps, but not stopped processes or similarly named programs', () => {
  const output = `  12 S /Applications/Paste.app/Contents/MacOS/Paste
  13 S+ /a path/Paste Easy.app/Contents/MacOS/Paste Easy
  14 Ss /tmp/Paste Like.app/Contents/MacOS/Paste Like
  15 T /Applications/Paste.app/Contents/MacOS/Paste
  16 S /Applications/NotPaste.app/Contents/MacOS/Paste
  17 S /Applications/Paste Easy.app/Contents/Frameworks/Paste Easy Helper.app/Contents/MacOS/Paste Easy Helper
  18 S /usr/bin/node`;
  assert.deepEqual(activeRecorders(output).map(value => value.pid), [12, 13, 14]);
});
test('UI preflight fails before launching or touching the clipboard if isolation cannot be confirmed', () => {
  assert.throws(() => assertClipboardIsolation({ platform: 'darwin', list: () => '42 S /Applications/Paste.app/Contents/MacOS/Paste' }), /42:.*Paste/);
  assert.throws(() => assertClipboardIsolation({ platform: 'darwin', list: () => { throw new Error('process inspection failed'); } }), /inspection failed/);
  assert.doesNotThrow(() => assertClipboardIsolation({ platform: 'darwin', list: () => '42 T /Applications/Paste.app/Contents/MacOS/Paste' }));
  assert.doesNotThrow(() => assertClipboardIsolation({ platform: 'linux', list: () => { throw new Error('must not run'); } }));
});
