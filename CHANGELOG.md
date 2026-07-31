# Changelog

## 2026-08-01

- 为清空剪贴板历史增加确认弹窗，覆盖顶部清空按钮和系统托盘 `Clear History` 两个入口。
- 根因：清空历史属于不可撤销的破坏性操作，之前两个入口都会一次点击直接删除全部记录，容易造成误删。
- 验证：`npm install`、`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`、`npm run build`。
- 影响范围：仅主进程清空历史流程；不改变剪贴板监听、复制/粘贴、搜索和历史文件格式。

## 2026-06-17

- 修复搜索框聚焦时 `Enter` 会触发选中剪贴板项复制/粘贴的问题；根因是窗口级 `keydown` 捕获阶段没有区分文本输入事件和应用快捷键。
- 搜索框内的左右方向键现在保留为光标移动，避免被剪贴板卡片导航拦截。
- 验证：`npm run build`、`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`。
- 影响范围：仅渲染进程键盘交互；不改变剪贴板存储、主进程监听、构建配置。
