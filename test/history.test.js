const test = require('node:test');
const assert = require('node:assert/strict');
const { addSnapshotToHistory } = require('../src/history');

test('keeps pinned state when a duplicate snapshot is moved to the front', () => {
  const existing = {
    id: 'clip-1',
    createdAt: '2026-08-30T01:00:00.000Z',
    isFavorite: true,
    signature: 'sig-a',
    type: 'text',
    title: 'Old title',
    body: 'same text',
    preview: 'same text'
  };

  const other = {
    id: 'clip-2',
    createdAt: '2026-08-30T01:01:00.000Z',
    isFavorite: false,
    signature: 'sig-b',
    type: 'text',
    title: 'Other',
    body: 'other text',
    preview: 'other text'
  };

  const { history, item } = addSnapshotToHistory([other, existing], {
    signature: 'sig-a',
    type: 'text',
    title: 'New title',
    body: 'same text',
    preview: 'same text'
  }, {
    createId: () => 'new-id',
    now: () => '2026-08-30T02:00:00.000Z'
  });

  assert.equal(history.length, 2);
  assert.equal(history[0].id, 'clip-1');
  assert.equal(history[0].isFavorite, true);
  assert.equal(history[0].title, 'New title');
  assert.equal(history[0].createdAt, '2026-08-30T02:00:00.000Z');
  assert.equal(history[1].id, 'clip-2');
  assert.equal(item, history[0]);
});

test('creates a new unpinned item for a new snapshot and trims history', () => {
  const { history } = addSnapshotToHistory([{
    id: 'clip-1',
    createdAt: '2026-08-30T01:00:00.000Z',
    isFavorite: true,
    signature: 'sig-a',
    type: 'text',
    title: 'Old',
    body: 'old',
    preview: 'old'
  }], {
    signature: 'sig-b',
    type: 'text',
    title: 'New',
    body: 'new',
    preview: 'new'
  }, {
    maxItems: 1,
    createId: () => 'clip-2',
    now: () => '2026-08-30T02:00:00.000Z'
  });

  assert.deepEqual(history, [{
    id: 'clip-2',
    createdAt: '2026-08-30T02:00:00.000Z',
    isFavorite: false,
    signature: 'sig-b',
    type: 'text',
    title: 'New',
    body: 'new',
    preview: 'new'
  }]);
});
