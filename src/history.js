const crypto = require('crypto');

function addSnapshotToHistory(currentHistory, snapshot, options = {}) {
  if (!snapshot) {
    return { history: currentHistory, item: null };
  }

  const {
    maxItems = 300,
    createId = () => crypto.randomUUID(),
    now = () => new Date().toISOString()
  } = options;

  const existingItem = currentHistory.find((item) => item.signature === snapshot.signature);
  const nextHistory = currentHistory.filter((item) => item.signature !== snapshot.signature);
  const item = {
    id: existingItem?.id || createId(),
    createdAt: now(),
    isFavorite: existingItem?.isFavorite || false,
    ...snapshot
  };

  return {
    history: [item, ...nextHistory].slice(0, maxItems),
    item
  };
}

module.exports = {
  addSnapshotToHistory
};
