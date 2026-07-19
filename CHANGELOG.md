# Changelog

## 2026-07-18

- 清空历史现在会先弹出确认框，覆盖窗口顶部按钮和托盘菜单，避免误点导致全部剪贴板历史立即丢失。
- 根因：`history:clear` IPC 和托盘 `Clear History` 菜单之前都直接清空内存并写盘，没有用户确认或取消路径。
- 验证：`npm install`、`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`、`npm run build`。
- 影响范围：仅主进程清空历史流程；不改变剪贴板监听、复制/粘贴、搜索筛选或历史文件格式。

## 2026-06-17

- 修复搜索框聚焦时 `Enter` 会触发选中剪贴板项复制/粘贴的问题；根因是窗口级 `keydown` 捕获阶段没有区分文本输入事件和应用快捷键。
- 搜索框内的左右方向键现在保留为光标移动，避免被剪贴板卡片导航拦截。
- 验证：`npm run build`、`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`。
- 影响范围：仅渲染进程键盘交互；不改变剪贴板存储、主进程监听、构建配置。
