# Jishu Hub 打包与发布指南

本文档详细说明了如何构建和发布 Jishu Hub 的不同版本安装包，包括 **Windows 本地打包 (Full 和 Lite 版)** 以及 **macOS 云端自动化打包**。

## 1. 概念说明

- **Full 版 (全量版)**：内置了底层的 `pi` 源码。安装后需在检测页点击“一键安装”，应用会自动将其提取至 `~/.jishu-agent/pi` 并在用户的 Node.js 环境下编译安装。此举是为了保证 Native 模块的 ABI 兼容并规避系统目录只读权限问题。
- **Lite 版 (精简版)**：仅包含 Jishu Hub 界面和原生的 `jishu` CLI 命令行工具。用户点击安装时，会通过系统全局的 `npm install -g` 等包管理器在线下载并安装底层 Agent。体积较小（约十几兆）。

---

## 2. Windows 平台打包 (本地构建)

在执行打包前，请确保已经安装并配置好 **Node.js** 和 **Rust** 环境。

### 第一步：打包全量版 (Full)

1. 在项目根目录执行打包命令：
   ```bash
   npm run build
   ```
2. 构建脚本会自动执行前端编译、内置 Pi 引擎打包、Rust 后端编译，以及 Tauri 安装包生成。
3. 打包完成后，脚本会**自动**重命名输出文件，最终的安装包将生成在以下路径：
   `src-tauri/target/release/bundle/nsis/Jishu Hub Full_<版本号>_x64-setup.exe`

### 第二步：打包精简版 (Lite)

1. 全量版打包完成后，接着执行精简版打包命令：
   ```bash
   npm run build -- --lite
   ```
2. 构建脚本会自动跳过 Pi 引擎的打包，仅打包界面和 `jishu` CLI 命令行工具，并**自动**重命名输出包。
3. 最终的安装包会生成在同一路径：
   `src-tauri/target/release/bundle/nsis/Jishu Hub Lite_<版本号>_x64-setup.exe`

> **原理解释（为何不直接改 Tauri 配置里的 productName）**：
> Tauri 的安装包文件名是由配置中的 `productName` 决定的。如果直接在配置文件把名字设为 "Jishu Hub Full"，会导致用户最终安装时的默认路径、开始菜单名、卸载列表全变成 "Jishu Hub Full"，使得 Full 版和 Lite 版不再能无缝互相覆盖更新。因此，业界标准做法是保持安装后的应用名为 "Jishu Hub" 不变，并在打包结束后由自动化脚本去重命名带有后缀的 `.exe` 安装包文件。

至此，你的 Windows 全量版和精简版安装包就都准备就绪了。

---

## 3. macOS 平台打包 (GitHub Actions 自动构建)

由于跨平台编译 macOS 原生应用（`.app` / `.dmg`）较为困难，我们已配置好了 GitHub Actions 流水线，完全免除了本地配置苹果环境的烦恼。

### 触发自动打包

1. 确保你的本地代码已全部提交 (Commit)。
2. 将代码推送到 GitHub 的默认分支（或当前工作分支）：
   ```bash
   git push
   ```
3. 代码推送后，GitHub Actions 会**自动触发**名为 `MacOS Build` 的工作流任务。

### 获取打包结果

1. 打开项目的 GitHub 仓库页面，点击上方的 **Actions** 标签。
2. 找到最新运行的 `MacOS Build` 任务并点击进入。
3. 往下滑动至底部的 **Artifacts** 区域，你会看到打包好的 macOS 应用：
   - `Jishu-Hub-Mac-Full.dmg`
   - `Jishu-Hub-Mac-Lite.dmg`
   （流水线脚本已自动帮你完成了重命名操作，下载后解压即可发布）。

---

## 附录：关于 jishu CLI
无论是全量版还是精简版，在最新架构中，均通过 Tauri Sidecar 机制注入了由 Rust 编写的 `jishu` 全局命令行程序（导致精简版体积相比老版本增加了 10M 左右）。用户安装任何版本后，终端均可直接调用 `jishu` 命令行，保持了极佳的灵活性。
