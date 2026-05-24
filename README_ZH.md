<div align="center">

# Jishu Hub（机枢）

### Claude Code 桌面管理客户端 —— 项目、会话、配置一站管理

[![Version](https://img.shields.io/github/v/release/wang5766171/jishu-hub?color=blue&label=版本)](https://gitee.com/wangzwa/jishu-hub/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](https://gitee.com/wangzwa/jishu-hub/releases)
[![Download](https://img.shields.io/badge/下载-latest%20release-brightgreen.svg)](https://gitee.com/wangzwa/jishu-hub/releases)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-orange.svg)](https://tauri.app/)

[English](README.md) | [中文](#)

镜像：[Gitee（国内加速）](https://gitee.com/wangzwa/jishu-hub) | [GitHub](https://github.com/wang5766171/jishu-hub)

</div>

## 为什么选择 Jishu Hub？

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 是强大的 AI 编程 CLI 工具，但日常使用中总有些不方便：

- 多个项目切换要反复敲命令
- 会话历史只能翻 JSONL 文件
- 改配置要手动编辑 `settings.json`，容易出错
- 想和 AI 对话还得打开终端

**Jishu Hub** 给 Claude Code 套上了一层图形界面，让你可以：

- **应用内对话** —— 不用开终端，直接在 Hub 内和 Claude 交流，支持发送任意文件附件
- **项目管理** —— 自动发现所有项目，一键切换
- **会话浏览** —— 搜索和回看完整对话历史，支持语法高亮
- **配置编辑** —— 表单化操作，告别 JSON 手误
- **插件架构** —— 预留多智能体扩展能力

## 界面预览

<!-- 在此处添加截图，格式如下： -->
<!--
<p align="center">
  <img src="./docs/screenshots/chat-zh.png" alt="对话页面" width="49%" />
  <img src="./docs/screenshots/manage-zh.png" alt="管理页面" width="49%" />
</p>
-->

> 📸 截图即将上传

## 功能特性

### 对话
- 应用内直接与 Claude 对话，无需打开终端
- 支持发送任意格式文件附件（图片、文档、代码等）
- 项目内文件自动识别，直接引用路径不重复复制
- 支持粘贴、拖拽、文件选择器三种方式添加附件
- 流式输出 + Markdown 实时渲染

### 会话管理
- 按项目分组浏览所有会话
- 搜索会话内容，快速定位历史对话
- 自定义会话名称，方便管理
- 会话可一键在终端中继续

### 项目管理
- 自动发现 `~/.claude/projects/` 下的所有项目
- 显示会话数、最后活跃时间
- 通过文件夹选择器添加项目（含未初始化项目）

### 配置管理
- 可视化表单编辑 `settings.json`
- 模型选择、环境变量、插件开关
- 配置预设保存与一键切换
- 自动备份 + 一键恢复历史版本

### 自定义命令
- 创建和管理自定义斜杠命令
- 直接在界面中执行

### 个性化
- 三种主题：浅色 / 色彩 / 暗色（默认暗色）
- 系统界面和会话内容字体独立调节（四档预设）
- 中英文双语支持，自动识别系统语言

## 快速开始

前往 [GitHub Releases](https://github.com/wang5766171/jishu-hub/releases/latest) 下载最新版本安装包。

国内用户可从 [Gitee Releases](https://gitee.com/wangzwa/jishu-hub/releases) 下载。

**系统要求**：Windows 10 及以上

## 贡献

欢迎贡献代码、报告问题或提出建议！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 发起 Pull Request

<details>
<summary><strong>本地开发</strong></summary>

### 环境要求

| 软件 | 最低版本 | 用途 |
|------|----------|------|
| [Node.js](https://nodejs.org/) | 18+ | 前端构建 |
| [Rust](https://rustup.rs/) | 1.77+ | 后端编译 |
| [VS Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/) | 最新 | Windows C++ 工具链 |

### 构建运行

```bash
git clone https://github.com/wang5766171/jishu-hub.git
cd jishu-hub
npm install
npm run tauri dev
```

</details>

<details>
<summary><strong>技术架构</strong></summary>

| 层 | 技术 |
|----|------|
| 桌面框架 | [Tauri v2](https://v2.tauri.app/) |
| 前端 | [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) |
| UI | [shadcn/ui](https://ui.shadcn.com/) + [Tailwind CSS v4](https://tailwindcss.com/) |
| 后端 | [Rust](https://www.rust-lang.org/) |
| 国际化 | [i18next](https://www.i18next.com/) |

</details>

<details>
<summary><strong>数据存储</strong></summary>

| 路径 | 说明 |
|------|------|
| `~/.claude/projects/` | Claude Code 项目数据 |
| `~/.claude/settings.json` | 全局配置 |
| `~/.jishu-hub/` | Hub 元数据（会话名称、预设、状态） |

</details>

## License

[MIT](LICENSE) © 2025 Jishu Hub
