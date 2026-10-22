const { fileDetails } = require('./transfers');

function copySource(item) {
  return Object.freeze({ id: item.id, signature: item.signature, type: item.type, asset: item.asset });
}

function verifyCopySources(store, references, changedMessage = '所选内容已改变或删除，剪贴板未修改，请重新选择。') {
  for (const reference of references) {
    const current = store.getMetadata(reference.id);
    if (!current || current.signature !== reference.signature || current.type !== reference.type || current.asset !== reference.asset) throw Error(changedMessage);
  }
  // File availability can change while the system helper is awaited even when
  // the stored URL and content identity are unchanged.
  for (const reference of references) if (reference.type === 'file') {
    const files = fileDetails(store.get(reference.id));
    if (!files.length || files.some(file => !file.exists)) throw Error('原始文件已移动或删除，剪贴板未修改。');
  }
}

module.exports = { copySource, verifyCopySources };
