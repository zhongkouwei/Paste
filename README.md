# Paste Easy

一个模仿 macOS Paste 交互的剪贴板历史应用。核心目标不是做网页展示，而是做可常驻的桌面工具：监听系统剪贴板、保存历史、用全局快捷键唤起底部浮层，并把选中的历史内容重新复制或粘贴到当前应用。

## 功能

- 自动记录文本、链接、代码片段和图片剪贴板内容
- 底部横向时间线，接近 Paste 的快速浏览形态
- 搜索、类型筛选、置顶、删除、清空历史
- 系统托盘常驻
- `Command+Shift+V` 唤起窗口
- 点击 `⌘V` 复制所选内容并尝试粘贴到当前应用
- 历史记录持久化到 Electron `userData` 目录

## 运行

```bash
npm install
npm start -- --show
```

如果 Electron 二进制下载慢，可以使用镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

## macOS 权限

普通复制和历史记录不需要额外权限。自动粘贴依赖系统模拟 `Command+V`，多屏幕下按前台窗口定位唤起屏幕也需要读取前台窗口位置；macOS 可能要求给 Electron 进程授予辅助功能权限：

`System Settings` -> `Privacy & Security` -> `Accessibility`

未授权时，仍然可以点击 `Copy` 把历史内容放回剪贴板，再手动粘贴；快捷键唤起位置会退回到鼠标所在屏幕。

## 主要文件

- `src/main.js`：Electron 主进程，负责剪贴板监听、托盘、快捷键、持久化和粘贴动作
- `src/preload.js`：安全暴露 IPC API
- `src/index.html`：窗口结构
- `src/renderer.js`：搜索、筛选、选择、复制、置顶、删除等交互
- `src/styles.css`：Paste 风格底部浮层 UI
