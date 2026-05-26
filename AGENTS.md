# Jishu Hub (机枢)

A Tauri desktop hub for managing AI agent projects, sessions, and configuration. Currently supports Codex CLI with a plugin architecture for future agents.

## Build

```bash
npm run tauri build
```

## Dev

```bash
npm run tauri dev
```

## Test (Rust backend)

```bash
cd src-tauri && cargo test
```

## Architecture

- `src-tauri/src/main.rs` — Tauri entry point
- `src-tauri/src/lib.rs` — IPC command registration, AppState with AgentRegistry
- `src-tauri/src/agent/` — Plugin abstraction layer
  - `agent/mod.rs` — AgentPlugin trait + AgentRegistry
  - `agent/Codex.rs` — Codex CLI implementation
- `src-tauri/src/project.rs` — Scan projects from ~/.Codex/projects/, path encoding
- `src-tauri/src/config.rs` — Load/save/backup/restore Codex settings.json
- `src-tauri/src/session.rs` — Parse JSONL session files
- `src-tauri/src/history.rs` — Load ~/.Codex/history.jsonl
- `src-tauri/src/hub.rs` — Manage ~/.jishu-hub/ metadata (session names, state, presets)
- `src-tauri/src/chat.rs` — Spawn CLI processes, stream events
- `src/` — React + TypeScript frontend
- `src/pages/chat-page.tsx` — Main two-column chat view
- `src/pages/manage-page.tsx` — Project/config/commands management
- `src/components/sessions/` — MessageView, ChatInput, StreamingMessage

## Data Locations

- Agent data: `~/.Codex/` (Codex specific)
- Projects: `~/.Codex/projects/<encoded-path>/`
- Config: `~/.Codex/settings.json`
- History: `~/.Codex/history.jsonl`
- Backups: `~/.Codex/backups/`
- Hub data: `~/.jishu-hub/` (session names, presets, state, agents)
