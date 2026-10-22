const { randomUUID } = require('node:crypto');
const WRITE_ID_TYPE = 'com.zhongkouwei.paste-easy.write-id';
const WRITE_ID_MIME = `electron application/osclipboard;format="${WRITE_ID_TYPE}"`;
const validWriteID = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const validLease = value => !!value && Number.isSafeInteger(value.version) && value.version >= 0 && validWriteID(value.token);

class ClipboardOwnership {
  constructor({ readVersion, check, token = randomUUID, onError = () => {} }) { Object.assign(this, { readVersion, check, token, onError }); }
  async write(write) {
    let version;
    try { version = await this.readVersion(); } catch (error) { this.onError(error); }
    const token = this.token();
    if (!validWriteID(token)) throw new Error('Invalid clipboard write identity');
    const signature = await write(token);
    // A single atomic write claims ownership once. Reading a version AFTER writing
    // could instead certify a newer copy made by another application.
    const lease = Number.isSafeInteger(version) && version >= 0 && version < Number.MAX_SAFE_INTEGER
      ? Object.freeze({ version: version + 1, token }) : null;
    return { signature, lease };
  }
  async verify(lease) {
    if (!validLease(lease)) return { ok: false, error: 'clipboard-unavailable' };
    try { return await this.check(lease); }
    catch (error) { this.onError(error); return { ok: false, error: 'clipboard-unavailable' }; }
  }
}
module.exports = { ClipboardOwnership, WRITE_ID_TYPE, WRITE_ID_MIME, validWriteID, validLease };
