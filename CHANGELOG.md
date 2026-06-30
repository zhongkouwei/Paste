# Changelog

## 2026-06-30

- 修复旧版或损坏历史项缺少 `title`、`type`、`preview`、`signature` 等字段时，渲染进程搜索/展示可能中断的问题；根因是主进程 `loadHistory()` 只过滤了 `id` 和 `body`，没有恢复完整历史项数据契约。
- 现在加载持久化历史时会统一归一化字段：补齐类型、标题、预览、签名、HTML 和置顶状态，保证 IPC 返回给 UI 的历史项结构稳定。
- 验证：`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`、`npm run build`。
- 影响范围：仅历史文件加载后的字段修复；剪贴板监听、复制/粘贴、删除、清空和现有历史文件路径不变。

## 2026-06-28

- 修复历史项时间戳缺失、损坏或来自未来时间时，卡片时间可能显示为 `NaNd` 的问题；根因是渲染进程 `relativeTime()` 直接对 `Date` 计算结果做分钟换算，没有校验无效时间。
- 现在无效时间戳显示为 `unknown`，未来时间按 `now` 处理，避免损坏历史文件或迁移数据污染 UI。
- 验证：`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`、`npm run build`。
- 影响范围：仅剪贴板卡片时间标签渲染；历史持久化、筛选、复制/粘贴和图片处理不变。

## 2026-06-27

- 修复历史项已被删除或渲染进程持有过期 `id` 时仍可能触发自动粘贴的问题；根因是主进程 `history:copy` 不区分目标条目是否存在，找不到条目时仍会隐藏窗口并模拟 `Command+V`。
- 现在只有成功把目标历史项写回系统剪贴板后，才会执行自动粘贴；找不到条目时返回 `false`，保留当前窗口与系统剪贴板状态。
- 验证：`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`、`npm run build`。
- 影响范围：仅历史项复制/粘贴 IPC 防护；剪贴板监听、历史持久化、删除/清空和 UI 渲染不变。

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
