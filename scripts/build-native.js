const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.platform !== 'darwin') process.exit(0);
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'native/bin'), { recursive: true });
execFileSync('xcrun', ['clang', '-O2', '-fobjc-arc', '-framework', 'Cocoa', '-framework', 'ApplicationServices',
  path.join(root, 'native/bridge.m'), '-o', path.join(root, 'native/bin/paste-bridge')], { stdio: 'inherit' });
