<div align="center">

# Jishu Hub

### A Desktop Manager for Claude Code — Projects, Sessions & Config in One Place

[![Version](https://img.shields.io/github/v/release/wang5766171/jishu-hub?color=blue&label=version)](https://github.com/wang5766171/jishu-hub/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](https://github.com/wang5766171/jishu-hub/releases)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-orange.svg)](https://tauri.app/)

[English](#) | [中文](README_ZH.md)

Mirror: [Gitee（国内镜像）](https://gitee.com/wangzwa/jishu-hub)

</div>

## Why Jishu Hub?

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) is a powerful AI coding CLI — but everyday use has its friction:

- Switching between projects requires repeated terminal commands
- Session history is buried in JSONL files
- Editing config means hand-editing `settings.json` (easy to make mistakes)
- Chatting with AI means opening a terminal every time

**Jishu Hub** wraps Claude Code in a native desktop GUI:

- **In-App Chat** — Talk to Claude directly inside Hub, no terminal needed. Send any file type as attachments
- **Project Management** — Auto-discovers all projects, one-click switching
- **Session Browser** — Search and browse full conversation history with syntax highlighting
- **Config Editor** — Form-based editing, no more JSON typos
- **Plugin Architecture** — Extensible multi-agent framework ready for future agents

## Screenshots

<!-- Add screenshots here, format:
<p align="center">
  <img src="./docs/screenshots/chat-en.png" alt="Chat Page" width="49%" />
  <img src="./docs/screenshots/manage-en.png" alt="Manage Page" width="49%" />
</p>
-->

> Screenshots coming soon

## Features

### Chat
- Chat with Claude directly in the app, no terminal required
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
- Auto-discovers all projects under `~/.claude/projects/`
- Shows session count and last active time
- Add projects via folder picker (including uninitialized projects)

### Configuration
- Visual form editor for `settings.json`
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
| `~/.claude/projects/` | Claude Code project data |
| `~/.claude/settings.json` | Global configuration |
| `~/.jishu-hub/` | Hub metadata (session names, presets, state) |

</details>

## License

[MIT](LICENSE) © 2025 Jishu Hub
