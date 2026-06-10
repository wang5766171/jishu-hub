# Jishu Hub 打包与发布指南

本文档详细说明了如何构建和发布 Jishu Hub 的不同版本安装包，包括 **Windows 本地打包 (Full 和 Lite 版)** 以及 **macOS 云端自动化打包**。

## 1. 概念说明

- **Full 版 (全量版)**：内置了底层的 `pi` 源码。打包时，系统会自动利用 esbuild 将 `coding-agent` 的各模块及依赖项打包为单一混淆过的 `cli.js`，并自动清理 TS 源码文件（如 `src` 文件夹）和无用配置（如 `.git` 文件夹），彻底去除了项目原始代码结构的清晰度。这有效缩减了体积且满足了代码闭源与混淆的诉求。安装后，Jishu Hub 会直接调用安装目录下 `third_party/pi-bundle` 中打包好的 `cli.js` 启动 Agent，实现了**真正的开箱即用**和**离线包效果**，无需再将其提取至用户目录或重新执行 `npm install`。
- **Lite 版 (精简版)**：仅包含 Jishu Hub 界面和原生的 `jishu` CLI 命令行工具。不内置底层 `pi` 引擎的任何代码。用户在使用时如果本地没有安装过 `pi`，可以选择在线一键安装（通过执行环境的包管理器如 `npm` 自动拉取源码）。体积较小（约十几兆）。

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

## 3. Lite 版前置依赖：发布 NPM 核心包

精简版 (Lite) 不内置核心的 Agent 引擎代码。如果底层逻辑（如 `third_party/pi` 子模块）发生了更新，或者你想向外发布一个全新的 Agent 引擎版本供 Lite 版云端拉取安装，你必须将最新的底层代码发布到 NPM 官方仓库。

由于我们在架构中实现了 **“无侵入式别名发布”**（将 `@earendil-works` 原生无缝映射为 `@jishu-hub` 下的私有包），因此发布流程不再使用 `pi` 目录下的命令，而是使用主仓库提供的专属构建流水线脚本。

1. **回到 `jishu-hub` 根目录**（不要进入 `third_party/pi`！）：
   ```bash
   cd D:/MyCodes/jishu-hub
   ```
2. 登录 NPM 官方仓库（如果你还没有登录过，确保登入 `@jishu-hub` 权限账号）：
   ```bash
   npm login --registry=https://registry.npmjs.org/
   ```
3. 运行一键发布脚本：
   ```bash
   node scripts/publish-pi.mjs
   ```
   > **原理解释**：此脚本会自动在后台跑 `npm install` 与 `npm run build`，随后在临时目录 `.publish-stage` 中使用 NPM Alias 特性将包的引用于发布前替换为 `@jishu-hub/jishu-agent` 等系列名称。该脚本内部已经强制绑定了 `https://registry.npmjs.org/` 作为发布源，所以即便你配置了淘宝镜像等，也完全不必担心报错 403 权限异常！

发布成功后，全球范围内的 Lite 客户端即可在界面一键拉取安装你刚刚上线的最新核心代码！

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
