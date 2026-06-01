<div align="center">

# Jishu Hub（机枢）

### A Multi-Agent Collaboration Platform for CLI-based AI Agents

[![Version](https://img.shields.io/github/v/release/wang5766171/jishu-hub?color=blue&label=version)](https://github.com/wang5766171/jishu-hub/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](https://github.com/wang5766171/jishu-hub/releases)
[![Size](https://img.shields.io/badge/size-<10MB-blue.svg)](https://github.com/wang5766171/jishu-hub/releases/latest)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-orange.svg)](https://tauri.app/)

[English](#) | [中文](README_ZH.md)

Mirror: [Gitee](https://gitee.com/wangzwa/jishu-hub)

</div>

## Why Jishu Hub?

AI coding agents are evolving rapidly — Claude Code, OpenAI Codex, Open Code, and more are emerging as powerful CLI tools. But managing them is fragmented: scattered terminals, buried session logs, hand-edited configs.

**Jishu Hub (机枢)** is a multi-agent collaboration platform that unifies these CLI-based AI agents in one desktop interface. Like precision gears in a machine — each agent is a "机枢" (a pivotal mechanism) — running stably and intelligently on the platform.

> **Zero overhead · Zero risk · Zero bloat**
>
> - **Native CLI passthrough** — connects directly to existing agent CLIs, no proxies, no wrappers, zero extra resource consumption
> - **Instant launch, tiny footprint** — built on Tauri v2 + Rust, installer under 10 MB, cold start in under a second
> - **Your data stays yours** — session history lives alongside each project in its own directory; Hub metadata stored locally in `~/.jishu-hub/`; nothing is ever uploaded

## Quick Start

Download the latest release from [GitHub Releases](https://github.com/wang5766171/jishu-hub/releases/latest).

For users in China, downloads are also available from [Gitee Releases](https://gitee.com/wangzwa/jishu-hub/releases).

**System Requirements**: Windows 10 or later

## Screenshots

### Main Chat Interface
<p align="center">
  <img src="./docs/screenshots/会话-暗.png" alt="Chat (Dark)" width="100%" />
</p>
A clean, focused, and immersive chat interface natively on your desktop. Jishu Hub replaces scattered terminal windows with a beautifully designed dark-mode workspace.

### Multimodal Capabilities
<p align="center">
  <img src="./docs/screenshots/图片会话.png" alt="Image Chat" width="49%" />
  <img src="./docs/screenshots/图片发送支持标注.png" alt="Image Annotation" width="49%" />
</p>
Engage in rich multimodal conversations. Send images and files effortlessly, and use built-in image annotation tools to highlight exactly what you need the AI to focus on.

### Multi-Agent Collaboration & Parallel Tasks
<p align="center">
  <img src="./docs/screenshots/智能体切换.png" alt="Agent Switching" width="49%" />
  <img src="./docs/screenshots/多任务的并行处理.png" alt="Parallel Tasks" width="49%" />
</p>
Switch smoothly between CLI agents (Claude Code, OpenAI Codex, Open Code, and more) via the plugin architecture. Run multiple sessions in parallel across projects without context interference.

### Project & Session Management
<p align="center">
  <img src="./docs/screenshots/项目管理.png" alt="Project Management" width="49%" />
  <img src="./docs/screenshots/项目全局搜索.png" alt="Global Search" width="49%" />
</p>
Projects are automatically discovered and organized. Instantly locate past conversations with the powerful global session search.

### Configuration Editor
<p align="center">
  <img src="./docs/screenshots/配置管理.png" alt="Config Management" width="100%" />
</p>
Ditch manual JSON edits. Use the visual form-based editor to manage models, environment variables, and agent presets — with built-in templates for popular providers and automatic backup & restore.

## Features

### Multi-Agent Platform
- Plugin-based agent registration and one-click switching
- Currently supports **Claude Code**, **OpenAI Codex**, **Open Code**, **Jishu Self**
- AgentPlugin trait abstraction — ready to onboard the next agent
- Built-in environment detection and one-click agent installation (npm / winget / choco)

### CLI & Orchestration (v0.6.0)
- `jishu` CLI binary with 15 subcommands for agents, projects, sessions, config, and more
- Orchestrator engine with planner/dispatcher architecture for multi-step task execution
- LLM provider abstraction (OpenAI / Anthropic) with streaming support
- ACP (Agent Communication Protocol) server over stdio JSON-RPC
- Daemon mode for background task orchestration
- Evolution proposals for self-improving workflows

### In-App Chat
- Talk to AI agents directly inside Hub, no terminal required
- Send any file type as attachments (images, documents, code, etc.)
- Project-local files detected automatically — referenced by path, not copied
- Three ways to add files: paste, drag-and-drop, or file picker
- Streaming output with real-time Markdown rendering
- Floating window (picture-in-picture) for independent session viewing

### Session Management
- Browse all sessions grouped by project
- Full-text content search across sessions — instantly locate any conversation
- Custom session naming for easy identification
- Resume sessions in terminal with one click

### Project Management
- Auto-discovers all projects across agents
- Shows session count and last active time
- Add projects via folder picker (including uninitialized projects)

### Configuration
- Visual form editor for agent settings
- Model selector, environment variables, plugin toggles
- Built-in templates for popular providers (OpenRouter, SiliconFlow, etc.)
- Save and switch between config presets
- Auto-backup with one-click restore

### Custom Commands
- Create and manage custom slash commands
- Execute commands directly from the UI

### Personalization
- Three themes: Light / Colorful / Dark (dark by default)
- Independent font size control for UI and chat content (4 presets)
- Bilingual support (Chinese & English), auto-detects system language

## Contributing

Contributions are welcome! Whether it's code, bug reports, or feature suggestions.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

<details>
<summary><strong>Local Development</strong></summary>

### Prerequisites

| Tool | Min Version | Purpose |
|------|-------------|---------|
| [Node.js](https://nodejs.org/) | 18+ | Frontend build |
| [Rust](https://rustup.rs/) | 1.77+ | Backend compile |
| [VS Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/) | Latest | Windows C++ toolchain |

### Build & Run

```bash
git clone https://github.com/wang5766171/jishu-hub.git
cd jishu-hub
npm install
npm run tauri dev
```

</details>

<details>
<summary><strong>Tech Stack</strong></summary>

| Layer | Technology |
|-------|-----------|
| Desktop Framework | [Tauri v2](https://v2.tauri.app/) |
| Frontend | [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) |
| UI | [shadcn/ui](https://ui.shadcn.com/) + [Tailwind CSS v4](https://tailwindcss.com/) |
| Backend | [Rust](https://www.rust-lang.org/) |
| i18n | [i18next](https://www.i18next.com/) |

</details>

<details>
<summary><strong>Data Locations</strong></summary>

| Path | Description |
|------|-------------|
| `~/.jishu-hub/` | Hub metadata (agents, session names, presets, state, models) |
| `~/.jishu-hub/models.json` | LLM model presets configuration |
| `~/.jishu-hub/runs/` | Orchestrator run traces (JSONL) |
| `~/.claude/` | Claude Code agent data |
| `~/.codex/` | Codex agent data |

</details>

## License

[MIT](LICENSE) © 2025 Jishu Hub
