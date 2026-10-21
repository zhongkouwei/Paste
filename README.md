# Paste Easy

macOS 本地剪贴板工具。当前以本机 Paste 7.0.2 的可见行为为参考重建，**正在开发，尚未达到完整功能对齐、像素级验收或对外发行标准**。实测、差距和下一步见 [docs/PARITY.md](docs/PARITY.md)。使用独立名称与自主实现，不打包 Paste 的程序代码、图标或服务凭据。

## 开发与验证

环境：macOS arm64、Node.js >= 22.12、Xcode Command Line Tools。依赖锁定在 package-lock.json；Electron 45 的剪贴板接口为异步 ClipboardItem。

```bash
npm ci --registry=https://registry.npmjs.org
npm run build:native
npm start -- --show
```

默认快捷键 `Command+Shift+V`。与原版 Paste 同时运行时可能被占用，可在设置中更换。自动粘贴通过原生辅助程序激活之前的目标进程并发送 Command+V，需要辅助功能权限；未授权时会复制内容并明确提示，不报告粘贴成功。

`Command+Shift+C` 启动 Stack；两个全局快捷键、Pinboard 导航、快速粘贴及纯文本修饰键均可在设置中调整。支持把卡片拖入 Pinboard、拖动排序；图片/文件卡片悬停时的拖动图标使用原始文件。Space 打开独立预览，原图、富文本与多文件分别显示；未保存编辑会阻止直接关闭或覆盖草稿。

文本编辑支持粗体、斜体、下划线、删除线、选区格式和撤销/重做，保留基础字体、字号和颜色；未实际修改时不重写原始 HTML/RTF。复杂表格、嵌入图片等尚不能无损编辑，当前禁止静默转换为简化文本。代码、链接、颜色内容仍用纯文本编辑器，避免自动格式化。

图片可左右旋转、移除/恢复背景、撤销/重做、恢复原图；保存只更新当前项目，保留原图、固定状态和名称。背景移除调用 macOS 14+ 的 Vision 前景分割，保留画布尺寸与透明度；恢复背景不改变旋转方向。旋转由系统 Core Image/ImageIO 执行，每次从原图或未旋转前景计算，不连续重采样；编辑输入限制为 64 MB、6400 万像素。高位深、广色域及大图压力验收尚未完成；分割边缘可能残色，复杂主体质量尚需验证，不能据此宣称全面无损或精确抠图。

图片自动使用系统 Vision 识别文字，并参与搜索及图片内匹配高亮；预览中可选择/复制识别结果、手动重试，也可从图片右键菜单复制文字。优先中英文语言，单任务 30 秒、结果 1 MB、最多 10000 行/20000 词；失败明确显示，不改写图片。任务按图片版本去重并串行，过期结果不会覆盖新图；识别等待期间发生其他复制时，旧复制请求不会覆盖新剪贴板。应用不上传图片进行识别；系统模型可用性及其他语言/复杂版面准确率仍需验证。

```bash
npm run check
npm test
npm run test:ui
npm run build
npm run test:packaged
npm audit --omit=dev --registry=https://registry.npmjs.org
npm run release:verify
```

- `check`：所有源码、脚本与测试的 JavaScript 语法检查。
- `test`：存储、迁移、损坏恢复、Pinboard、搜索与保留策略。
- `test:ui`：真实 Electron + IPC + 系统剪贴板；使用隔离测试数据，不读取已有历史。测试前保存、结束后恢复系统剪贴板。运行前退出其他剪贴板记录工具，可避免其收录测试内容。
- `test:ui` 运行前自动编译原生桥和编辑器；构建产物也包含编辑器离线包，不依赖 CDN。
- `test:packaged`：对构建产物运行同一组端到端测试。
- UI 截图在忽略 Git 的 `test-results/`，包括 1920/1280/768/390pt 宽度。窄屏测试验证溢出与稳定尺寸，不代表已经支持 iOS。

## 数据

正式数据位于 `~/Library/Application Support/Paste Easy/`。首次升级会合并该目录及 `paste-like`、`Paste Like` 的旧 `clipboard-history.json`，按内容去重并保留固定状态；原始文件不修改。不读取原版 Paste 的数据库。

`library.json` 原子写入并保留 `.bak`，图片原始 PNG 独立存入 `assets/`；文件权限为 0600。主文件损坏时保留损坏副本并恢复有效备份；无有效备份时停止启动，不用空历史覆盖原文件。当前尚未实现静态加密和图片垃圾回收，不能将文件权限等同于加密或安全擦除。

删除历史保留 Pinboard 中的项目；删除 Pinboard 不删除其项目。正在编辑的项目在窗口关闭前免于自动到期/容量清理和清空历史，显式删除会被拒绝。历史期限变更立即执行，固定内容豁免。`PASTE_DATA_DIR` 可指定隔离数据目录；`--test-mode` 关闭自动监听与全局快捷键，仅用于开发验收。

监听按系统剪贴板变化计数读取内容；未变化时不重复读取/解码图片，读取途中变化会丢弃旧候选并重试。暂停期间不补录，设置保存和自主复制分别串行执行。HTML 签名忽略 Electron 添加的已知编码前缀；图片按尺寸与解码像素识别，旧图片记录首次升级会一次性迁移签名，保留 ID/固定状态和原始文件。全量 JSON 写入、全库 IPC 和原图存储回收仍需继续优化。

导出 JSON 包含当前图片、可恢复原图和已有前景图，采用 0600 临时文件原子替换；不把本机图片资产路径当作完整备份。OCR 缓存保存在同一库中，绑定当前图片签名，图片改变后重新识别；行/词定位按需读取，不在每次全库通知中传输。导入恢复流程尚未实现。项目 `.npmrc` 和锁文件使用公开 npm registry，已通过独立缓存的重新安装；审计也必须使用公开库。本机全局默认镜像的零漏洞结果不能代替公开漏洞库，构建依赖仍有 8 项 moderate。

## 构建与发行

`npm run build` 生成 `release/mac-arm64/Paste Easy.app`，仅使用 ad-hoc 开发签名。构建后必须通过真实产物测试；**开发签名不等于 Apple Developer ID，也不代表通过 Gatekeeper 或可以对外发放**。

发行构建使用 `npm run build:release`，必须提供 `CSC_NAME` 对应的 Developer ID Application 身份，以及 Apple notarization 凭据：API Key 三项 `APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER`，或 `APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID`。凭据不写入仓库。

`release:verify` 顺序验证 codesign 完整性、Gatekeeper、stapled notarization，任一失败均返回非零。当前机器缺少 Developer ID 身份，尚不能生成合格发行版。不要关闭 Gatekeeper、清除隔离属性或对已被撤销的旧包重新签名来代替发行验证。

## 代码入口

- `src/main.js`：窗口、监听、IPC、原生粘贴与设置。
- `src/clipboard.js`：同一次剪贴板读取中的文本、HTML、RTF、原图和文件格式。
- `src/monitor.js`：变化计数、异步读取失效、暂停边界和自主复制抑制。
- `src/editor-entry.mjs` / `src/image-editor.js`：Tiptap 基础富文本编辑、系统图像处理与非破坏性图片草稿。
- `src/image-text.js` / `native/images.m`：版本化 OCR 队列、系统 Vision 识别/分割与 Core Image 处理。
- `src/preview.*` / `src/transfers.js`：独立预览、受隔离的富文本显示、原始文件拖出与系统分享。
- `src/store.js` / `src/model.js`：原子存储、迁移、Pinboard 与搜索策略。
- `src/renderer.js` / `src/styles.css`：虚拟横向卡片、搜索、多选、预览编辑与 Stack。
- `src/settings.*`：独立设置窗口。
- `native/bridge.m`：前台应用、原生图标、辅助功能状态与明确目标的粘贴。
- 文件剪贴板使用原生 NSPasteboard 多项 URL 读写；不依赖只保留最后一项的 Electron 多文件写入路径。
