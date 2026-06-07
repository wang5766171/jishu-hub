# PI_CHANGE.MD

本文档管理 `third_party/pi_agent_rust` 的 fork 仓库规则与改动记录。

---

# 第一部分：通用管理规则

## 1.1 仓库关系

```
┌─────────────────────────────────┐
│  jishu-hub（本项目）              │
│  submodule: third_party/         │
│            pi_agent_rust         │
│          ↓ 指向自有 fork         │
└──────────────┬──────────────────┘
               │ git submodule
               ▼
┌─────────────────────────────────┐
│  wang5766171/pi_agent_rust      │
│  （自有 fork 仓库）               │
│  分支: release_v{tag}_change    │
│          ↑ merge 上游 tag        │
└──────────────┬──────────────────┘
               │ fork from
               ▼
┌─────────────────────────────────┐
│  Dicklesworthstone/pi_agent_rust│
│  （上游开源仓库）                 │
│  tags: v0.1.17, v0.1.18, ...   │
└─────────────────────────────────┘
```

**核心流程**：jishu-hub 通过 submodule 引用自有 fork 仓库的 `release_v{tag}_change` 分支；自有 fork 基于上游开源仓库的 tag 创建对应维护分支，并在其上叠加 jishu-hub 所需的定制改动。

## 1.2 当前状态

| 项目 | 值 |
|------|-----|
| 上游仓库 | `https://github.com/Dicklesworthstone/pi_agent_rust` |
| 自有 fork | `https://github.com/wang5766171/pi_agent_rust` |
| 当前维护分支 | `release_v0.1.18_change`（基于上游 `v0.1.18` tag） |
| `.gitmodules` URL | 指向自有 fork |
| `.gitmodules` branch | `release_v0.1.18_change` |

## 1.3 日常源码变动流程

后续涉及 `pi_agent_rust` 源码的任何修改，按以下步骤操作：

1. **在子模块内直接修改代码**：
   ```bash
   cd third_party/pi_agent_rust
   # 修改文件...
   ```

2. **在子模块内提交并推送到 fork 分支**：
   ```bash
   git add -A
   git commit -m "feat: 描述本次改动"
   git push origin release_v0.1.18_change
   ```

3. **回到 jishu-hub 主仓库，提交 submodule 指针更新**：
   ```bash
   cd ../..  # 回到 jishu-hub 根目录
   git add third_party/pi_agent_rust
   git commit -m "chore: update pi_agent_rust submodule"
   ```

## 1.4 上游版本升级流程

当上游发布新版本（如 `v0.1.19`）时：

1. 在自有 fork 仓库中 fetch 上游 tags 并创建新维护分支：
   ```bash
   git fetch upstream --tags
   git checkout -b release_v0.1.19_change v0.1.19
   ```

2. 将上一版本的 Jishu 定制改动 cherry-pick 到新分支：
   ```bash
   git cherry-pick <commit-hash>...
   ```
   重放时必须逐项检查下文"1.5 合并 upstream 检查原则"中的检查点。

3. 确认 Jishu 定制改动已完整 cherry-pick，逐项检查改动详情中描述的每一处修改是否保留（代码逻辑、新增方法、条件分支等），并有针对性地编写或执行对应的测试验证改动内容在新基线上仍然正确。

4. 验证通过后推送：
   ```bash
   git push origin release_v0.1.19_change
   ```

5. 更新 jishu-hub submodule 指向新的 release 分支：
   ```bash
   # 子模块内 checkout 新分支
   git checkout release_v0.1.19_change
   # 主仓库更新 .gitmodules 的 branch 字段和 submodule 指针
   git add third_party/pi_agent_rust
   git commit -m "chore: upgrade pi_agent_rust to v0.1.19"
   ```

## 1.5 合并 upstream 检查原则

合并新的 `pi_agent_rust` upstream tag 时，不要盲目覆盖本地改动。必须逐项检查：

1. upstream 是否已经支持 ACP 模式下的 CLI provider/model/api-key/thinking 覆盖。
2. upstream 是否已经避免把 prompt 错误静默折叠为正常 `end_turn`。
3. upstream 是否已经在 ACP event bridge 中处理最终消息 fallback 或等效能力。
4. upstream 是否已经提供"同一会话保留历史，但每轮可刷新 provider client"的能力。
5. upstream 是否已经修复 Windows 长进程内第二次 HTTPS 请求的 `WSAENOTCONN / 10057` 问题。

如果 upstream 已有等效修复，应优先采用 upstream 实现，但必须重新执行 ACP 双轮验证。若 upstream 没有等效修复，则保留本地 patch。

## 1.6 Jishu Hub 侧依赖契约

Jishu Hub 依赖以下 Pi ACP 行为：

- ACP 启动命令中的 provider/model/api-key/thinking 必须生效。
- `session/new` 返回的 `sessionId` 必须可用于后续多轮 `session/prompt`。
- 多轮对话必须保留上下文。
- runtime 错误必须显性返回 JSON-RPC error 或 `agent_message_chunk` 错误文本，不能只返回空 `turn_complete`。
- Windows 本地 GUI 长进程运行时，连续多轮 HTTPS 请求必须稳定。

这些契约是 Jishu Hub agent adapter 和 GUI 会话能力的基础，后续不能因为同步 upstream 而回退。

## 1.7 注意事项

- 分支命名统一为 `release_v{tag版本号}_change`，与上游 tag 版本一一对应。
- fork 仓库中已删除 `.github/workflows/`（避免 GitHub OAuth `workflow` scope 限制）。
- 每个维护分支都能明确回答"基于哪个 upstream tag 改了什么"。

---

# 第二部分：改动记录

## 2026-06-07 | 基线 v0.1.18 — ACP 长进程稳定化

### 改动总览

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main.rs` | 修改 | CLI 参数传递到 ACP runtime |
| `src/acp.rs` | 修改 | CLI 覆盖 + 错误透出 + MessageEnd fallback + 会话持久化 |
| `src/agent.rs` | 新增方法 | `refresh_provider_client_from_entry(...)` 每轮重建 client |
| `src/http/client.rs` | 修改 | Windows TCP 建连改用标准库绕开 asupersync bug |

**上游基线**：`v0.1.18` tag (`9e8af33b`)

**改动背景**：

Jishu Hub 接入 Pi ACP runtime 后，出现过如下问题：

1. GUI 与 `jishu agent` 对话第一条正常，第二条只收到 `turn_complete`，没有回复内容。
2. 进一步探针验证发现，第二轮不是 GUI 丢事件，而是 Pi ACP 内部第二次请求没有产出 `agent_message_chunk`。
3. 继续定位后发现，底层错误曾被 Pi ACP 折叠成正常 `end_turn`，导致 GUI 看到"空完成"，无法暴露真实失败原因。
4. 错误透出后确认，Windows 长进程内第二次 HTTPS 请求会触发 `TLS connect failed ... os error 10057`。
5. 同一个 ACP 进程中，即使新建第二个 session，第二次网络请求仍失败，证明根因不在会话历史，而在 Pi HTTP/TCP 建连路径。

改动目标不是临时兼容 GUI，而是让 Pi runtime 在 Jishu Hub 的 ACP 长进程模式下具备稳定、可诊断、可连续对话的能力。

### 改动详情

#### `src/main.rs` — CLI 参数传递

ACP 启动分支增加 CLI 参数向 ACP runtime 的传递：

- `cli_provider`
- `cli_model`
- `cli_api_key`
- `cli_thinking`

原因：

- Jishu Hub 的 adapter 会生成正式 `jishu ...` / Pi ACP 启动参数，ACP runtime 必须尊重这些 CLI 参数。
- 当 CLI 显式传入 `api-key` 时，不能只从 `get_available()` 过滤后的模型里选择，否则自定义 provider/model 可能被错误排除。
- 现在有 `api-key` 覆盖时使用完整模型列表，避免 ACP 启动时选不到 Jishu GUI 指定的 provider/model。

#### `src/acp.rs` — ACP 层四类修复

**修复一**：ACP 模型、key、thinking 选择逻辑支持 CLI 覆盖：

- `select_acp_model_entry(...)` 支持 `cli_provider` / `cli_model` 优先。
- `resolve_acp_api_key(...)` 支持 `cli_api_key` 优先，然后再走 auth storage 和 model entry。
- `resolve_acp_thinking_level(...)` 支持 `cli_thinking` 优先，然后再走 config default。

原因：Jishu Hub 适配层要求"adapter 生成正式 CLI 命令，ACP runtime 按命令入参执行"。不能让 ACP 在后台重新选择一个与 GUI 配置不一致的默认模型。

**修复二**：ACP 错误不再静默折叠为 `end_turn`：

- `run_prompt(...)` 从返回 `&'static str` 改为返回 `Result<&'static str, String>`。
- prompt 执行失败时返回 JSON-RPC error，而不是伪装成正常 `stopReason=end_turn`。

原因：之前第二轮失败被 GUI 表现为"空完成"，无法排查。Jishu Hub 需要显性展示 agent/runtime 错误，便于用户或调度中枢做干预决策。

**修复三**：ACP event bridge 增加 `MessageEnd` fallback：

- 如果流式过程中没有发出 text/thinking delta，但最终 assistant message 中有内容，则在 `MessageEnd` 补发 `agent_message_chunk` / `agent_thought_chunk`。
- 如果最终 assistant message 只有 `error_message`，则补发文本形式的错误块：`Error: ...`。

原因：不同 provider 可能不按完全相同的 delta 事件形态返回内容。GUI 侧需要尽可能收到可展示的最终内容或错误信息，而不是只收到完成事件。

**修复四**：ACP 会话必须走 Pi 正常持久化 session：

- `session/new` 从 `Session::in_memory()` 改为 `Session::create()`。
- `AgentSession::new(...)` 的 `save_enabled` 从 `false` 改为 `true`。
- 新增回归测试 `session_new_creates_save_enabled_agent_session`，防止 ACP 会话再次被建成临时会话。

原因：Jishu Hub GUI 切换会话、重新进入会话、重启后恢复历史，最终都依赖 Pi 写到 `~/.jishu-agent/sessions/<encoded-cwd>/*.jsonl` 的真实记录。前一次连续对话修复把 GUI 对 jishu-self 的交互推进到 ACP 长会话，但 ACP 会话仍按临时 session 创建，导致 live stream 能看到回复，切换会话后从 JSONL 读取不到完整历史。不能用前端缓存补这个问题；缓存只能遮住当前页面，不能满足会话列表、会话切换、重启恢复和后续任务调度对真实历史的依赖。

#### `src/agent.rs` — 每轮重建 provider client

新增：

```rust
AgentSession::refresh_provider_client_from_entry(...)
```

行为：

- 根据指定 `ModelEntry` 重建 provider client。
- 更新 stream options 中的 API key 和 headers。
- 刷新 extension completion host state。
- 不清空、不替换 `AgentSession` 的会话历史。

原因：ACP 是长进程、多轮会话模式。多轮对话需要保留同一个 `AgentSession` 的消息历史。但底层 provider client 在 Windows 长进程里复用后触发第二次请求失败，因此每轮 prompt 前需要刷新 provider client。原有 `apply_session_model_selection(...)` 在 provider/model 不变时会直接返回，不能满足"同模型也重建 client"的需求。

新增测试：`refresh_provider_client_from_entry_rebuilds_current_provider`

#### `src/http/client.rs` — Windows TCP 建连路径

Windows 下 TCP 建连路径改为：

- 使用标准库 `std::net::TcpStream::connect_timeout(...)` 建立连接。
- 连接成功后设置 `TCP_NODELAY`。
- 再通过 `asupersync::net::tcp::stream::TcpStream::from_std(...)` 包装回 asupersync stream。

非 Windows 平台保持原逻辑：继续使用 `asupersync::net::tcp::stream::TcpStream::connect(...)`。

原因：真实 ACP 双轮探针证明，同一 Windows 进程内第二次 HTTPS 请求会失败：`TLS connect failed ... os error 10057`。asupersync 0.3.2 自身源码中也有对 Windows 非阻塞 connect / `WSAENOTCONN` 边界情况的说明。这里使用标准库阻塞 connect 作为 Windows 专用建连路径，绕开该非阻塞 connect 边界；TLS、SSE、provider 协议保持不变。

### 验证结果

**单元测试**：

```powershell
cargo test --manifest-path third_party\pi_agent_rust\Cargo.toml session_new_creates_save_enabled_agent_session --lib
cargo test --manifest-path third_party\pi_agent_rust\Cargo.toml acp --lib
cargo test --manifest-path third_party\pi_agent_rust\Cargo.toml refresh_provider_client_from_entry_rebuilds_current_provider --lib
cargo build --manifest-path third_party\pi_agent_rust\Cargo.toml --bin pi --release
```

**ACP 双轮探针**：

- 同一个 ACP 进程，同一个 `sessionId`。
- 连续执行两次 `session/prompt`。
- 第一轮返回 `stopReason=end_turn`，且有 `agent_message_chunk`。
- 第二轮返回 `stopReason=end_turn`，且有 `agent_message_chunk`。
- 第二轮不再出现 `TLS connect failed ... os error 10057`。

**持久化验证**（2026-06-07）：

- 使用 release `pi.exe` 启动 ACP，模型 `zhipu/glm-5.1`。
- 连续两次 `session/prompt` 后读取 JSONL，消息角色顺序为：`user, assistant, user, assistant`。
- 切换会话时 GUI 读取的底层历史文件已包含两轮 assistant 回复。

**本地 runtime 同步**：

- `src-tauri/target/debug/pi.exe`
- `src-tauri/target/release/pi.exe`
- `src-tauri/bin/pi-x86_64-pc-windows-msvc.exe`
