# Changelog

## 0.2.0-dev / 2026-10-21

- 以本机 Paste 7.0.2 为行为参考，重建 332pt 底部浮层、240pt 横向卡片、居中 Pinboard、内联重命名、搜索筛选和独立设置窗口。
- 新增 Pinboard 管理、稳定多选、预览编辑、纯文本复制、Stack、来源图标与前台目标恢复的原生桥；高级能力及精确视觉验收仍在开发，不宣称完整对齐。
- 修复图片缩小后替代原图、重复复制丢失固定状态、写入失败后内存与磁盘不一致，以及保留期限未即时执行的问题。
- 增加原子写入、备份恢复、旧产品目录合并迁移、机密/瞬时剪贴板过滤和错误提示；不修改原版 Paste 的数据库。
- 升级 Electron 并迁移异步 ClipboardItem API；仅从同一次读取组合文本、富文本、图片和文件。
- 开发包使用完整 ad-hoc 签名；发行命令要求 Developer ID 与公证，新增独立 release:verify 防止无效产物被当作可发行版本。
- 验证：npm run check、npm test（14 项）、npm run test:ui（11 项）、npm run build、npm run test:packaged（11 项）；原图像素/尺寸、富文本/文件 round-trip、隐私标记、2,000 项虚拟列表和多尺寸截图均有覆盖。签名完整性通过，Gatekeeper 发行验收尚未通过。
- 影响范围：主进程、渲染层、设置、存储、原生桥、构建与测试；历史原始文件保留。完整差距与发布门槛记录在 docs/PARITY.md。

## 2026-06-17

- 修复搜索框聚焦时 `Enter` 会触发选中剪贴板项复制/粘贴的问题；根因是窗口级 `keydown` 捕获阶段没有区分文本输入事件和应用快捷键。
- 搜索框内的左右方向键现在保留为光标移动，避免被剪贴板卡片导航拦截。
- 验证：`npm run build`、`node --check src/main.js && node --check src/preload.js && node --check src/renderer.js`。
- 影响范围：仅渲染进程键盘交互；不改变剪贴板存储、主进程监听、构建配置。
