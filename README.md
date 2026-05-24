<div align="center">

# Jishu Hub（机枢）

### A Multi-Agent Collaboration Platform for CLI-based AI Agents

[![Version](https://img.shields.io/github/v/release/wang5766171/jishu-hub?color=blue&label=version)](https://github.com/wang5766171/jishu-hub/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](https://github.com/wang5766171/jishu-hub/releases)
[![Download](https://img.shields.io/badge/download-latest%20release-brightgreen.svg)](https://github.com/wang5766171/jishu-hub/releases/latest)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-orange.svg)](https://tauri.app/)

[English](#) | [中文](README_ZH.md)

Mirror: [Gitee](https://gitee.com/wangzwa/jishu-hub)

</div>

## Why Jishu Hub?

AI coding agents are evolving rapidly — Claude Code, OpenAI Codex, and more are emerging as powerful CLI tools. But managing them is fragmented: scattered terminals, buried session logs, hand-edited configs.

**Jishu Hub (机枢)** is a multi-agent collaboration platform that unifies these CLI-based AI agents in one desktop interface. Like precision gears in a machine — each agent is a "机枢" — running stably and intelligently on the platform.

Currently running **Claude Code** as the first agent, with a plugin architecture designed to onboard more agents as they emerge.

- **Multi-Agent Platform** — Plugin architecture to onboard any CLI-based AI agent, not locked to one provider
- **In-App Chat** — Talk to AI agents directly inside Hub, no terminal needed. Send any file type as attachments
- **Session Browser** — Search and browse full conversation history across all projects
- **Project Management** — Auto-discovers projects, one-click switching
- **Config Editor** — Form-based editing with presets and auto-backup
- **Extensible by Design** — AgentPlugin trait abstraction, ready for the next agent

## Screenshots

<!-- Add screenshots here, format:
<p align="center">
  <img src="./docs/screenshots/chat-en.png" alt="Chat Page" width="49%" />
  <img src="./docs/screenshots/manage-en.png" alt="Manage Page" width="49%" />
</p>
-->

> Screenshots coming soon

## Features

### Agent Collaboration
- Plugin-based agent registration and switching
- Currently supports Claude Code CLI
- AgentPlugin trait abstraction for easy onboarding of new agents

### Chat
- Chat with AI agents directly in the app, no terminal required
- Send any file type as attachments (images, documents, code, etc.)
- Project-local files detected automatically — referenced by path, not copied
- Three ways to add files: paste, drag-and-drop, or file picker
- Streaming output with real-time Markdown rendering

### Session Management
- Browse all sessions grouped by project
- Search session content to quickly find past conversations
- Custom session naming for easy identification
- Resume sessions in terminal with one click

### Project Management
- Auto-discovers all projects
- Shows session count and last active time
- Add projects via folder picker (including uninitialized projects)

### Configuration
- Visual form editor for agent settings
- Model selector, environment variables, plugin toggles
- Save and switch between config presets
- Auto-backup with one-click restore

### Custom Commands
- Create and manage custom slash commands
- Execute commands directly from the UI

### Personalization
- Three themes: Light / Colorful / Dark (dark by default)
- Independent font size control for UI and chat content (4 presets)
- Bilingual support (Chinese & English), auto-detects system language

## Quick Start

Download the latest release from [GitHub Releases](https://github.com/wang5766171/jishu-hub/releases/latest).

For users in China, downloads are also available from [Gitee Releases](https://gitee.com/wangzwa/jishu-hub/releases).

**System Requirements**: Windows 10 or later

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
| `~/.jishu-hub/` | Hub metadata (agents, session names, presets, state) |
| `~/.claude/` | Claude Code agent data |

</details>

## License

[MIT](LICENSE) © 2025 Jishu Hub
