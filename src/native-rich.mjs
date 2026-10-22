import createDOMPurify from 'dompurify';
import { STYLE_PROPERTIES, createRichContentPolicy, embeddedImage } from './rich-content.mjs';

export async function nativeRichHTML(html, window = globalThis.window) {
  if (typeof html !== 'string' || html.length > 16 * 1024 * 1024) return { html: '', reason: '富文本超过转换限制，原文未修改。' };
  const purifier = createDOMPurify(window); let reason = '';
  purifier.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'IMG' && !embeddedImage(node.getAttribute('src'))) { node.removeAttribute('src'); reason = '此RTF包含未能内嵌的图像，原文未修改。'; }
  });
  const safe = purifier.sanitize(html, { WHOLE_DOCUMENT: true, ADD_TAGS: ['style'], ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'link', 'base', 'meta', 'iframe', 'object', 'embed', 'form', 'input', 'video', 'audio', 'source'] });
  const parsed = new window.DOMParser().parseFromString(safe, 'text/html');
  if (parsed.querySelectorAll('*').length > 20000) return { html: '', reason: '富文本结构过大，原文未修改。' };
  const frame = window.document.createElement('iframe'); frame.hidden = true; frame.tabIndex = -1; frame.setAttribute('sandbox', 'allow-same-origin');
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">';
  let timer;
  try {
    await new Promise((resolve, reject) => {
      frame.onload = resolve; timer = setTimeout(() => reject(new Error('富文本样式读取超时，原文未修改。')), 5000);
      frame.srcdoc = `<!doctype html><html><head>${csp}${parsed.head.innerHTML}</head><body>${parsed.body.innerHTML}</body></html>`; window.document.body.append(frame);
    });
    const document = frame.contentDocument, nodes = [...document.body.querySelectorAll('*')], properties = new Map(nodes.map(node => [node, new Set(STYLE_PROPERTIES.filter(name => node.style.getPropertyValue(name)))]));
    let rules = 0, work = 0;
    for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
      if (rule.type !== 1 || ++rules > 256 || (work += nodes.length) > 200000) { reason ||= '此RTF样式超出可编辑范围，原文未修改。'; continue; }
      const names = STYLE_PROPERTIES.filter(name => rule.style.getPropertyValue(name));
      for (const node of nodes) if (node.matches(rule.selectorText)) for (const name of names) properties.get(node).add(name);
    }
    // The browser performs the cascade and shorthand expansion in an isolated document.
    for (const node of nodes) {
      const computed = frame.contentWindow.getComputedStyle(node), inline = document.createElement('span').style;
      for (const name of properties.get(node)) inline.setProperty(name, computed.getPropertyValue(name));
      if (inline.cssText) node.setAttribute('style', inline.cssText);
    }
    for (const style of document.querySelectorAll('style')) style.remove();
    const result = createRichContentPolicy(window).inspect(document.body.innerHTML);
    return { html: result.html, reason: reason || result.reason };
  } finally { clearTimeout(timer); frame.remove(); }
}
