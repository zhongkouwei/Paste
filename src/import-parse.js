const fs = require('node:fs');
const { Tokenizer, TokenParser, TokenType: T } = require('@streamparser/json');

async function parseBackup(file, receive, { signal, maxBytes = 8 * 1024 ** 3, maxItemBytes = 384 * 1024 ** 2, maxString = 90 * 1024 ** 2 } = {}) {
  const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('备份必须是普通 JSON 文件，且不超过 8 GiB。');
  const tokenizer = new Tokenizer({ stringBufferSize: 65536, numberBufferSize: 1024, emitPartialTokens: true }), frames = [];
  let parser, legacy = false, items = false, itemStart = null, bytes = 0, tokens = 0, headerStart = null, boardBytes = 0, lastTokenBytes = 0, longNumber = false;
  tokenizer.parseNumber = value => { if (value.length > 1024) longNumber = true; return Number(value); };
  const queue = [], header = { boards: [], settings: {} };
  tokenizer.onToken = token => {
    const frame = frames.at(-1);
    const keyToken = token.token === T.STRING && frame?.keyExpected;
    if (headerStart !== null && token.offset - headerStart > 4 * 1024 ** 2) throw new Error('备份头部项目超过 4 MiB 限制。');
    if (typeof token.value === 'string' && token.value.length > (frame?.keyExpected ? 256 : headerStart !== null ? Math.min(maxString, 4 * 1024 ** 2) : maxString)) throw new Error('备份中的字段过大。');
    if (itemStart !== null && token.offset - itemStart > maxItemBytes) throw new Error('单个备份项目过大。');
    if (token.partial) return;
    lastTokenBytes = bytes;
    if (++tokens > 50000000) throw new Error('备份结构超过限制。');
    if (!parser) {
      if (![T.LEFT_BRACE, T.LEFT_BRACKET].includes(token.token)) throw new Error('备份根节点必须是对象或旧版数组。');
      legacy = token.token === T.LEFT_BRACKET; items = legacy;
      parser = new TokenParser({ paths: legacy ? ['$.*'] : ['$.items.*', '$.boards.*', '$.version', '$.settings'], keepStack: false });
      parser.onValue = ({ value, key, stack }) => {
        if (legacy || stack[1]?.key === 'items') { queue.push(value); itemStart = null; }
        else if (stack[1]?.key === 'boards') {
          boardBytes += Buffer.byteLength(JSON.stringify(value));
          if (header.boards.length >= 1000 || boardBytes > 16 * 1024 ** 2) throw new Error('Pinboard 数量或元数据超过限制。');
          header.boards.push(value); headerStart = null;
        } else { header[key] = value; if (key === 'settings') headerStart = null; }
      };
    }
    if (keyToken) {
      if (['__proto__', 'constructor', 'prototype'].includes(token.value) || frame.keys.has(token.value)) throw new Error('备份包含危险或重复的字段。');
      frame.keys.add(token.value); frame.key = token.value; frame.keyExpected = false;
      if (frame.keys.size > 1000) throw new Error('对象字段过多。');
      if (frames.length === 1 && !['items', 'boards', 'settings', 'version'].includes(token.value)) throw new Error('备份包含不支持的顶层字段。');
    }
    if (token.token === T.NUMBER && !Number.isFinite(token.value)) throw new Error('备份数值无效。');
    if (!legacy && frames.length === 1 && !frame.keyExpected && [T.STRING, T.NUMBER, T.TRUE, T.FALSE, T.NULL].includes(token.token)
      && !keyToken && frame.key !== 'version') throw new Error('备份字段结构无效。');
    if ([T.LEFT_BRACE, T.LEFT_BRACKET].includes(token.token)) {
      if (frames.length >= 64) throw new Error('备份嵌套超过限制。');
      if (!legacy && frames.length === 1) {
        const expected = { items: T.LEFT_BRACKET, boards: T.LEFT_BRACKET, settings: T.LEFT_BRACE }[frame.key];
        if (expected !== token.token) throw new Error('备份字段结构无效。');
        if (frame.key === 'items') items = true;
      }
      const role = frames.length === 0 && legacy ? 'items' : frames.length === 1 ? frame.key : '';
      if (frame?.role === 'items' && itemStart === null) itemStart = token.offset;
      if (role === 'settings' || frame?.role === 'boards') headerStart = token.offset;
      frames.push({ object: token.token === T.LEFT_BRACE, keyExpected: token.token === T.LEFT_BRACE, keys: new Set(), role });
    } else if ([T.RIGHT_BRACE, T.RIGHT_BRACKET].includes(token.token)) frames.pop();
    else if (token.token === T.COMMA && frame?.object) frame.keyExpected = true;
    parser.write(token);
  };
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 65536, signal })) {
    signal?.throwIfAborted(); bytes += chunk.length; if (bytes > maxBytes) throw new Error('备份超过大小限制。');
    tokenizer.write(chunk);
    if (longNumber || bytes - lastTokenBytes > (frames.at(-1)?.keyExpected ? 16384 : 128 * 1024 ** 2)) throw new Error('备份中的单个标记过大。');
    if (headerStart !== null && bytes - headerStart > 4 * 1024 ** 2) throw new Error('备份头部项目超过 4 MiB 限制。');
    if (itemStart !== null && bytes - itemStart > maxItemBytes) throw new Error('单个备份项目过大。');
    while (queue.length) await receive(queue.shift());
  }
  tokenizer.end(); if (!parser) throw new Error('备份为空。'); if (!parser.isEnded) parser.end();
  while (queue.length) await receive(queue.shift());
  if (!items || (!legacy && ![1, 2].includes(header.version))) throw new Error('不支持此备份版本或缺少项目数组。');
  return { ...header, version: legacy ? 1 : header.version, bytes };
}
module.exports = { parseBackup };
