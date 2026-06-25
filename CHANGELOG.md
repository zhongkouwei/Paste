# Changelog

## 2026-06-25

- 优化清空历史的防误触保护；根因是顶部 `Clear history` 按钮和托盘 `Clear History` 都直接执行清空，误点会立即删除全部历史。
- 现在清空历史前统一由主进程弹出原生确认框，取消会保留现有历史；确认后仍复用原有清空流程并同步重置 `lastSignature`。
- 验证：`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`、`npm run build`。
- 影响范围：仅清空历史入口和确认交互；单条删除、复制/粘贴、剪贴板监听和历史持久化格式不变。

## 2026-06-24

- 修复删除当前顶部剪贴板项或清空历史后，当前系统剪贴板内容可能无法再次被自动收录的问题；根因是主进程只在新增快照时更新 `lastSignature`，历史被删空或头项变化后没有同步重算去重基线。
- 现在 `loadHistory()`、托盘 `Clear History`、IPC `history:delete` 和 `history:clear` 都会把 `lastSignature` 同步到最新历史头项；清空历史后会重置为空，保证同一份当前剪贴板内容可以立即重新入库。
- 验证：`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`、`npm run build`。
- 影响范围：仅主进程剪贴板去重与历史删除/清空后的恢复行为；UI、图片持久化、搜索与粘贴流程不变。

## 2026-06-23

- 修复剪贴板历史持久化文件损坏时可能被下一次保存直接覆盖的问题；根因是 `loadHistory()` 捕获读取/解析失败后只清空内存，没有先保留原始文件。
- 现在历史文件不存在时仍按首次启动处理；历史文件存在但 JSON 损坏或顶层结构不是数组时，会先改名保留为 `clipboard-history.corrupt-*.json`，再从空历史继续启动。
- 验证：`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`、`npm run build`。
- 影响范围：仅主进程历史加载和异常恢复；剪贴板监听、复制/粘贴、渲染交互不变。

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
