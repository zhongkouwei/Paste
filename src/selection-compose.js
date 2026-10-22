window.selectionComposer.onRequest(async ({ id, parts }) => {
  try {
    const root = document.createElement('div'), fragments = [];
    for (const part of parts) {
      const block = document.createElement('div'); block.style.margin = '0';
      if (part.image) {
        const image = document.createElement('img'); image.src = `data:image/png;base64,${part.image}`; image.alt = part.title || '图片'; block.append(image); fragments.push('');
      } else if (part.html) {
        const result = await PasteEditor.nativeRichHTML(part.html);
        if (result.reason) throw Error(`无法完整合并所选富文本：${result.reason}`);
        const parsed = new DOMParser().parseFromString(result.html, 'text/html'); block.append(...parsed.body.childNodes); fragments.push(result.html);
      } else { block.style.whiteSpace = 'pre-wrap'; if (part.text) block.textContent = part.text; else block.append(document.createElement('br')); fragments.push(''); }
      root.append(block);
    }
    if (root.querySelectorAll('*').length > 20000) throw Error('合并后的结构过大，剪贴板未修改。');
    const html = root.innerHTML;
    if (new TextEncoder().encode(html).byteLength > 16 * 1024 * 1024) throw Error('合并格式超过16 MiB，剪贴板未修改。');
    window.selectionComposer.complete(id, { html, fragments, images: root.querySelectorAll('img').length });
  } catch (error) { window.selectionComposer.complete(id, null, error.message); }
});
