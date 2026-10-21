const { randomUUID } = require('node:crypto');

function planImport(current, incoming, { mode = 'merge', restoreSettings = false } = {}) {
  if (!['merge', 'replace'].includes(mode) || typeof restoreSettings !== 'boolean') throw new Error('无效的恢复选项。');
  const settings = restoreSettings ? incoming.settings : current.settings;
  if (mode === 'replace') return { data: { ...incoming, settings }, added: incoming.items.length, duplicates: 0, replaced: current.items.length };
  const boards = current.boards.map(board => ({ ...board })), boardMap = new Map(), boardIDs = new Set(boards.map(board => board.id));
  for (const board of incoming.boards) {
    const existing = boards.find(value => value.id === board.id);
    const id = existing && (existing.name !== board.name || existing.color !== board.color) ? randomUUID() : board.id;
    boardMap.set(board.id, id);
    if (!boardIDs.has(id)) { boards.push({ ...board, id, itemOrder: [] }); boardIDs.add(id); }
  }
  const items = current.items.map(item => ({ ...item, boardIds: [...item.boardIds] }));
  const signatures = new Map(items.map(item => [item.signature, item])), ids = new Set(items.map(item => item.id)), itemMap = new Map();
  let duplicates = 0, added = 0;
  for (const item of incoming.items) {
    const membership = item.boardIds.map(id => boardMap.get(id)), existing = signatures.get(item.signature);
    if (existing) { existing.boardIds = [...new Set([...existing.boardIds, ...membership])]; existing.isFavorite = !!existing.boardIds.length; itemMap.set(item.id, existing.id); duplicates++; }
    else {
      const id = ids.has(item.id) ? randomUUID() : item.id, value = { ...item, id, boardIds: membership, isFavorite: !!membership.length };
      items.push(value); ids.add(id); signatures.set(value.signature, value); itemMap.set(item.id, id); added++;
    }
  }
  for (const board of incoming.boards) {
    const target = boards.find(value => value.id === boardMap.get(board.id));
    if (board.itemOrder) target.itemOrder = [...new Set([...(target.itemOrder || []), ...board.itemOrder.map(id => itemMap.get(id))])];
  }
  return { data: { version: 3, items, boards, settings }, added, duplicates, replaced: 0 };
}
module.exports = { planImport };
