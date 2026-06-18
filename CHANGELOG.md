# Changelog

## 2026-06-18

- 修复图片剪贴板从历史中重新复制/粘贴后被降质的问题；根因是主进程采集图片时把 `320px` 缩略图同时用作持久化正文和 UI 预览，导致历史里保存的不是原图。
- 现在图片条目会持久化原始 `dataURL` 到 `body`，仅把缩略图保留在 `preview` 供卡片渲染。
- 验证：`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`、`npm run build`。
- 影响范围：图片剪贴板采集、持久化和再次复制/粘贴；文本、链接、代码和窗口交互逻辑不变。

## 2026-06-17

- 修复搜索框聚焦时 `Enter` 会触发选中剪贴板项复制/粘贴的问题；根因是窗口级 `keydown` 捕获阶段没有区分文本输入事件和应用快捷键。
- 搜索框内的左右方向键现在保留为光标移动，避免被剪贴板卡片导航拦截。
- 验证：`npm run build`、`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`。
- 影响范围：仅渲染进程键盘交互；不改变剪贴板存储、主进程监听、构建配置。
