const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { loadHistoryFile, saveHistoryFile } = require('../src/historyStore');

function tempHistoryPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-like-history-'));
  return path.join(dir, 'clipboard-history.json');
}

test('loadHistoryFile returns sanitized history from a valid file', () => {
  const filePath = tempHistoryPath();
  fs.writeFileSync(filePath, JSON.stringify([
    { id: '1', body: 'first', signature: 'sig-1' },
    { id: '', body: 'missing id' },
    { id: '2', body: 'second', signature: 'sig-2' }
  ]));

  const result = loadHistoryFile(filePath, 1);

  assert.deepStrictEqual(result.history, [{ id: '1', body: 'first', signature: 'sig-1' }]);
  assert.strictEqual(result.corruptBackupPath, null);
});

test('loadHistoryFile moves corrupt history aside before returning empty history', () => {
  const filePath = tempHistoryPath();
  fs.writeFileSync(filePath, '{"id":');

  const result = loadHistoryFile(filePath, 300);

  assert.deepStrictEqual(result.history, []);
  assert.ok(result.error);
  assert.ok(result.corruptBackupPath);
  assert.strictEqual(fs.existsSync(filePath), false);
  assert.strictEqual(fs.readFileSync(result.corruptBackupPath, 'utf8'), '{"id":');
});

test('saveHistoryFile writes via a replaceable JSON file', () => {
  const filePath = tempHistoryPath();
  saveHistoryFile(filePath, [{ id: '1', body: 'clip', signature: 'sig-1' }]);

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), [
    { id: '1', body: 'clip', signature: 'sig-1' }
  ]);
});
