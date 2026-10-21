const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('locked packages can be fetched without an internal company registry', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../package-lock.json'), 'utf8'));
  let count = 0;
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!entry.resolved) continue;
    const url = new URL(entry.resolved);
    assert.equal(url.protocol, 'https:', name); assert.equal(url.hostname, 'registry.npmjs.org', name);
    assert.ok(entry.integrity, `${name} must retain its locked integrity`); count += 1;
  }
  assert.ok(count > 0);
});
