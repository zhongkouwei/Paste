const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { dateRange, nextMidnight, suggestions, applySuggestion, activeFilters } = require('../src/search-filters');
const { filterItems } = require('../src/model');

test('date filters use local calendar bounds and exclude the next midnight', () => {
  const now = new Date(2026, 9, 22, 0, 1), today = new Date(2026, 9, 22), tomorrow = new Date(2026, 9, 23);
  assert.deepEqual(dateRange('today', now), { after: today.toISOString(), before: tomorrow.toISOString() });
  assert.deepEqual(dateRange('yesterday', now), { after: new Date(2026, 9, 21).toISOString(), before: today.toISOString() });
  assert.equal(dateRange('7', now).after, new Date(2026, 9, 16).toISOString());
  assert.equal(dateRange('30', now).after, new Date(2026, 8, 23).toISOString());
  assert.deepEqual(dateRange('', now), {}); assert.deepEqual(dateRange('garbage', now), {});
  assert.equal(nextMidnight(now), tomorrow.getTime());
  const items = [{ id: 'yesterday', createdAt: new Date(today.getTime() - 30000).toISOString() }, { id: 'today', createdAt: today.toISOString() },
    { id: 'tomorrow', createdAt: tomorrow.toISOString() }, { id: 'invalid', createdAt: 'invalid' }];
  assert.deepEqual(filterItems(items, dateRange('today', now)).map(item => item.id), ['today']);
  assert.equal(filterItems(items, { after: new Date(now - 86400000).toISOString() }).some(item => item.id === 'yesterday'), true);
  assert.deepEqual(filterItems(items, { after: 'invalid' }), []);
});
test('calendar filters respect daylight-saving 23 and 25 hour days rather than subtracting fixed durations', () => {
  const script = `const { dateRange } = require(process.argv[1]); process.stdout.write(JSON.stringify([dateRange('today', '2026-03-08T12:00:00-07:00'), dateRange('today', '2026-11-01T12:00:00-08:00')]));`;
  const ranges = JSON.parse(execFileSync(process.execPath, ['-e', script, path.resolve(__dirname, '../src/search-filters.js')], { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' }));
  assert.equal((Date.parse(ranges[0].before) - Date.parse(ranges[0].after)) / 3600000, 23);
  assert.equal((Date.parse(ranges[1].before) - Date.parse(ranges[1].after)) / 3600000, 25);
});
test('date comparisons use instants, and search pinboard membership does not reorder chronological results', () => {
  const items = [{ id: 'a', createdAt: '2026-10-22T01:30:00+08:00', boardIds: ['board'] },
    { id: 'b', createdAt: '2026-10-21T17:45:00Z', boardIds: ['board'] }, { id: 'c', createdAt: '2026-10-22T01:45:00-07:00', boardIds: [] }];
  const boards = [{ id: 'board', itemOrder: ['b', 'a'] }];
  assert.deepEqual(filterItems(items, { pinboard: 'board', boards, after: '2026-10-21T17:00:00Z', before: '2026-10-21T18:00:00Z' }).map(item => item.id), ['a', 'b']);
  assert.deepEqual(filterItems(items, { board: 'board', boards }).map(item => item.id), ['b', 'a']);
});
test('metadata suggestions consume only explicitly chosen words, preserving literal search until selection', () => {
  const state = { sources: [{ name: 'Mail', bundleId: 'mail' }, { name: 'Google Chrome', bundleId: 'chrome' }], boards: [{ id: 'work', name: '工作资料' }] };
  const query = 'mail link meeting slides', choices = suggestions(query, state);
  assert.equal(applySuggestion(query, choices.find(choice => choice.kind === 'source')), 'link meeting slides');
  assert.equal(applySuggestion(query, choices.find(choice => choice.kind === 'type')), 'mail meeting slides');
  assert.equal(applySuggestion('changed', choices[0]), null);
  assert.deepEqual(suggestions('https://example.com/mail', state), []); assert.deepEqual(suggestions('"mail" a:b AND OR', state), []);
  assert.equal(suggestions('chrome', state).find(value => value.kind === 'source').value, 'chrome');
  assert.equal(suggestions('ＬＩＮＫ', state).find(value => value.kind === 'type').value, 'link');
  assert.equal(suggestions('工作资料 计划', state).find(value => value.kind === 'pinboard').value, 'work');
  assert.equal(suggestions('ma', state).find(value => value.kind === 'source').exact, false);
});
test('suggestions prefer exact longest phrases and do not offer already active filters', () => {
  const query = 'last 7 days report';
  const choices = suggestions(query, { sources: [{ name: 'Report', bundleId: 'report' }] });
  assert.equal(choices[0].value, '7'); assert.equal(applySuggestion(query, choices[0]), 'report');
  assert.deepEqual(suggestions('mail link today 工作', { type: 'link', date: 'today', source: 'mail', pinboard: 'work', sources: [{ name: 'Mail', bundleId: 'mail' }], boards: [{ id: 'work', name: '工作' }] }), []);
  assert.equal(suggestions('today', { sources: Array.from({ length: 20 }, (_, n) => ({ name: `Today ${n}`, bundleId: String(n) })) }).length, 8);
});
test('active filters retain stable identities and captured names when metadata disappears', () => {
  assert.deepEqual(activeFilters({ type: 'all', source: '', date: '', pinboard: '' }), []);
  assert.deepEqual(activeFilters({}), []);
  assert.deepEqual(activeFilters({ type: 'text', source: 'gone', sourceName: 'Mail', date: 'today', pinboard: 'board', pinboardName: 'Work' }).map(value => [value.kind, value.value, value.label]),
    [['type', 'text', '文本'], ['source', 'gone', 'Mail'], ['date', 'today', '今天'], ['pinboard', 'board', 'Work']]);
});
