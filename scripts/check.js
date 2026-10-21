const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function check(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'vendor') check(file);
    else if (/\.(?:js|mjs)$/.test(file)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}
for (const dir of ['src', 'scripts', 'test']) if (fs.existsSync(dir)) check(dir);
console.log('JavaScript syntax checks passed.');
