# Changelog

## 2026-07-20

- 优化搜索和筛选无结果时的空状态；现在会明确提示当前条件没有匹配项，而不是误导为剪贴板历史为空。
- 计数标签在过滤结果少于总历史时显示当前展示数量，便于确认搜索或筛选是否生效。
- 根因：渲染逻辑只根据过滤后的列表长度展示固定空状态，没有区分“无历史”和“无匹配”。
- 验证：`npm run build`、`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`。
- 影响范围：仅渲染进程空状态和计数展示；不改变剪贴板监听、存储、复制、粘贴或构建配置。

## 2026-06-17

- 修复搜索框聚焦时 `Enter` 会触发选中剪贴板项复制/粘贴的问题；根因是窗口级 `keydown` 捕获阶段没有区分文本输入事件和应用快捷键。
- 搜索框内的左右方向键现在保留为光标移动，避免被剪贴板卡片导航拦截。
- 验证：`npm run build`、`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`。
- 影响范围：仅渲染进程键盘交互；不改变剪贴板存储、主进程监听、构建配置。
