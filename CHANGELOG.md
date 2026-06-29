# Changelog

## 2026-06-29

- 修复历史文件损坏时可能被下一次保存覆盖的问题；根因是 `loadHistory()` 在 JSON 解析失败后直接返回空历史，没有保留原始文件，后续写入会造成不可恢复的数据丢失。
- 历史记录保存改为临时文件写入后原子替换，降低进程中断导致 `clipboard-history.json` 半写入的概率。
- 新增 `npm test` 覆盖历史文件清洗、损坏文件备份和保存路径。
- 验证：`npm test`、`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js && node --check src/historyStore.js`、`npm run build`。
- 影响范围：仅 Electron 主进程历史持久化读写；不改变剪贴板监听、渲染交互或已存在有效历史文件格式。

## 2026-06-17

- 修复搜索框聚焦时 `Enter` 会触发选中剪贴板项复制/粘贴的问题；根因是窗口级 `keydown` 捕获阶段没有区分文本输入事件和应用快捷键。
- 搜索框内的左右方向键现在保留为光标移动，避免被剪贴板卡片导航拦截。
- 验证：`npm run build`、`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`。
- 影响范围：仅渲染进程键盘交互；不改变剪贴板存储、主进程监听、构建配置。
