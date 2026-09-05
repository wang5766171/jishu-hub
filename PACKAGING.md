# Jishu Hub 打包与发布指南

本文档说明如何构建和发布 Jishu Hub 安装包，包括 **Windows 本地打包** 与 **macOS 云端自动化打包**。

## 1. 版本说明

Jishu Hub 只发布一个发行版：内嵌 `pi` 引擎（jishu agent）的**全量版**。

- 打包时上游 `build-coding-agent-bundle.mjs`（pi v0.85.0 起）以 esbuild 将 `coding-agent` 各模块及依赖打包为混淆的 `dist/bundle/cli.js`（多入口 + 代码分割：cli / rpc-entry / coordinator / index / client + chunks），fork 的 `build-bundle.mjs` 输出 `dist/runtime-deps.json` 依赖清单；打包后清理 TS 源码（`src`）、无用配置（`.git`）等，满足闭源与混淆诉求。
- 安装器在安装/覆盖更新时会自动把 `pi-bundle` 装入用户目录（`~/.jishu-agent`），实现**开箱即用**与**离线运行**，用户无需手动 `npm install`。
- 卸载时会清理 agent 本体（`packages`/`node_modules`），避免残留冲突；用户数据按「删除用户数据」勾选决定。

> v0.7.2 起移除了精简版（Lite），agent 完全随 hub 安装包分发。

---

## 2. Windows 平台打包（本地构建）

打包前确保已安装 **Node.js** 与 **Rust**。

1. 在项目根目录执行：
   ```bash
   npm run build
   ```
2. 构建脚本自动完成：前端编译 → 内置 pi 引擎打包（`pack-pi.mjs`）→ Rust 后端编译 → `jishu-cli` sidecar → Tauri 安装包生成。
3. 安装包输出在：
   `src-tauri/target/release/bundle/nsis/Jishu Hub_<版本号>_x64-setup.exe`

> 安装器（NSIS）在 POSTINSTALL 阶段调用 `Jishu Hub.exe --install-agent` 把 pi-bundle 装到 `~/.jishu-agent`；POSTUNINSTALL 阶段清理 agent 本体。这样安装/更新 hub 即自动安装/更新 agent，卸载 hub 即清理 agent。

---

## 3. 打包流水线：单一依赖真相

`third_party/pi/packages/coding-agent/build-bundle.mjs` 输出 `dist/runtime-deps.json`，记录所有需运行时提供（未打进 bundle）的非 `@earendil-works` 依赖（v0.85.0 起 esbuild 打包本体由上游 `scripts/build-coding-agent-bundle.mjs` 承担，本文件只保留清单生成这一 fork 独有步骤）。

- 键为依赖名、值为版本；同一依赖在多个子包出现时取最高 semver。

`scripts/pack-pi.mjs` 把依赖**烘焙**进 `pi-bundle/node_modules`（`npm install` 后 `npm prune --omit=dev`），并在打包末尾**断言**每个依赖都物理存在——缺失即构建失败、大声报错（这正是过去被 workspace 全量安装掩盖的失败点，现在本地就能提前暴露）。

共享工具库 `scripts/lib/pi-common.mjs`：`fixShebang(distDir)` 规范化入口 shebang，`readRuntimeDeps(distDir)` 读取并校验清单。

---

## 4. macOS 平台打包（GitHub Actions 自动构建）

跨平台编译 macOS 原生应用（`.app` / `.dmg`）较困难，已配置 GitHub Actions 流水线。

### 触发自动打包

1. 确保本地代码已全部提交。
2. 推送到 GitHub 默认分支（或当前工作分支）：
   ```bash
   git push
   ```
3. GitHub Actions 自动触发 `MacOS Build` 工作流。

### 获取打包结果

1. 打开仓库 **Actions** 标签。
2. 找到最新的 `MacOS Build` 任务并进入。
3. 底部 **Artifacts** 区域下载 `JishuHub-macOS`（解压得 `Jishu Hub.dmg`）。

> macOS/Linux 无 NSIS POSTINSTALL 机制，agent 自动安装目前仅 Windows 覆盖；macOS/Linux 用户仍可在应用内「环境检测」页手动点「安装」（`install_internal_jishu_agent` 的 GUI 路径不变）。

---

## 附录：关于 jishu CLI

通过 Tauri Sidecar 机制注入由 Rust 编写的 `jishu` 全局命令行程序，安装时自动加入用户 PATH。用户安装后终端可直接调用 `jishu` 命令行。
