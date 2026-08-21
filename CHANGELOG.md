# Changelog

## 2026-08-22

- 修复图片剪贴板历史只保存 320px 缩略图、再次复制会丢失原始分辨率的问题；现在持久化原图，仅将渲染预览缩放为 320px。
- 验证：`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`、`npm run build`。
- 影响范围：仅新增图片的存储与再次复制质量；既有文本、链接、代码及历史记录格式不受影响。

## 2026-06-17

- 修复搜索框聚焦时 `Enter` 会触发选中剪贴板项复制/粘贴的问题；根因是窗口级 `keydown` 捕获阶段没有区分文本输入事件和应用快捷键。
- 搜索框内的左右方向键现在保留为光标移动，避免被剪贴板卡片导航拦截。
- 验证：`npm run build`、`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`。
- 影响范围：仅渲染进程键盘交互；不改变剪贴板存储、主进程监听、构建配置。
