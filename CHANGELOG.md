# Changelog

## 2026-08-27

- 修复图片剪贴板历史会丢失原始分辨率的问题；根因是采集阶段把 320px 缩略图同时作为预览和实际 `body` 持久化，导致从历史中再次复制图片时只能拿到降采样版本。
- 图片项现在保留原始 `nativeImage` data URL 用于复制/粘贴，同时继续使用 320px 缩略图作为界面预览，避免改变时间线渲染成本。
- 验证：`npm ci`、`node --check src/main.js`、`node --check src/preload.js`、`node --check src/renderer.js`、`npm run build`。
- 影响范围：仅图片剪贴板采集、持久化和回放；文本、链接、代码、搜索、筛选与窗口交互不变。

## 2026-06-17

- 修复搜索框聚焦时 `Enter` 会触发选中剪贴板项复制/粘贴的问题；根因是窗口级 `keydown` 捕获阶段没有区分文本输入事件和应用快捷键。
- 搜索框内的左右方向键现在保留为光标移动，避免被剪贴板卡片导航拦截。
- 验证：`npm run build`、`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`。
- 影响范围：仅渲染进程键盘交互；不改变剪贴板存储、主进程监听、构建配置。
