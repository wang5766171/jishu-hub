# PI_CHANGE.MD

本文档管理 `third_party/pi` 的 fork 仓库规则与改动记录。
---

# 第一部分：通用管理规则

## 1.1 核心指导原则（修改底线）

> **尽量复用原生开源能力，能不改就不改，不得不改再改；能小改动就不大改动，不得不大改才大改。无论什么样的改动，都必须如实、详细地记录到当前的这个文档中。**

## 1.2 仓库关系

```
┌─────────────────────────────────┐
│jishu-hub（本项目）              │
│  submodule: third_party/        │
│          pi                     │
│        │指向自有 fork           │
└──────────────┬──────────────────┘
               │git submodule
               ▼
┌─────────────────────────────────┐
│wang5766171/pi                   │
│（自有 fork 仓库）               │
│分支: release_v0.79.1-7          │
└──────────────┬──────────────────┘
               │fork from
               ▼
┌─────────────────────────────────┐
│earendil-works/pi                │
│（上游开源仓库）                 │
│tags: v0.78.1, ...               │
└─────────────────────────────────┘
```

**核心流程**：jishu-hub 通过 submodule 引用自有 fork 仓库的特定分支（命名规则为 `release_v<pi版本>-<自研版本>`）；自有 fork 基于上游开源仓库的 Tag 进行同步，并在其上叠加 jishu-hub 所需的改动。

## 1.3 版本管理规则（带有横杠后缀的版本机制）

为了让上游 Pi 版本与我们的自研迭代独立发展、互不干扰，并且完美兼容 NPM 官方的 Semantic Versioning 规范，我们采用 **<Pi版本号>-<自研版本号>** 的统一版本管理逻辑：

- **自研版本号**为横杠后面的纯数字递增。当前第一版的完整版本号为 `0.78.1-1`。
- **顺延与升级规则**：
  - 如果只有自研内容升级，只需更新尾号：`0.78.1-1` -> `0.78.1-2`。
  - 如果合并了上游的更新（如 Pi 升级到了 `0.78.2`），自研尾号保持顺延不变。即：`0.78.1-2` 合并新版 Pi 后，完整版本号自动变为 `0.78.2-2`。
- **展示与发布的格式统一**：
  - **界面展示 (UI)**：展示为 `0.78.1-1`。
  - **代码分支 (Branch)**：命名为 `release_v0.79.1-7`。
  - **NPM 发布包 (package.json)**：使用 `0.78.1-1`（在 NPM 生态中完美支持，属于预发布版本变体机制）。

## 1.4 当前状态

| 项目 | 地址 |
|------|-----|
| 上游仓库 | `https://github.com/earendil-works/pi` |
| 自有 fork | `https://github.com/wang5766171/pi` |
| 当前维护分支 | `release_v0.80.2-8` |
| `.gitmodules` URL | `https://github.com/wang5766171/pi` |
| `.gitmodules` branch | `release_v0.80.2-8` |

## 1.5 日常源码变动流程

后续涉及 `pi` 源码的任何修改，按以下步骤操作：

1. **在子模块内直接修改代码**：
   ```bash
   cd third_party/pi
   # 确保处于当前对应的 release_vX.X.X-X 分支
   # 修改文件...
   ```

2. **在子模块内提交并推送到 fork 分支**：
   ```bash
   git add -A
   git commit -m "feat: 描述本次改动"
   git push origin release_v0.79.1-7
   ```

3. **回到 jishu-hub 主仓库，提交 submodule 指针更新**：
   ```bash
   cd ../..  # 回到 jishu-hub 根目录
   git add third_party/pi
   git commit -m "chore: update pi submodule"
   ```

## 1.6 上游版本升级流程

当上游开源仓库发布了新版本（例如 `v0.78.2`）时，需更新分支并合并代码：

1. **获取最新的上游 tags 并创建新分支**：
   ```bash
   cd third_party/pi
   git fetch upstream
   # 基于上游的新 tag 创建对应的新分支（保留当前的自研尾号，如 -1）
   git checkout -b release_v0.79.1-7 v0.78.2
   ```

2. **合并旧版本分支中的自有改动（例如定制规则和依赖修复等）**：
   ```bash
   git merge release_v0.79.1-7
   ```
   *注意：如果在合并时产生冲突，请手动解决冲突，保留 Jishu 的定制改动。*

3. **验证通过后推送到远端自有 fork**：
   ```bash
   git push -u origin release_v0.79.1-7
   ```

4. **更新 jishu-hub 仓库的子模块指向**：
   - 记得同时更新 `.gitmodules` 文件里的 `branch` 字段为新的 `release_v0.79.1-7`。
   ```bash
   cd ../..
   git add third_party/pi .gitmodules
   git commit -m "chore: upgrade pi submodule to v0.79.1-3"
   ```

---

# 第二部分：改动记录

## 2026-07-16 | AgentSession RPC 暴露 queued continuation 状态

**背景**：Task Conductor 在 awaited `agent_end` 扩展处理器内等待用户确认，并可用 `sendMessage(triggerTurn)` 排入下一阶段。Pi 原有 RPC 事件只暴露 `willRetry`，Hub 无法区分“本次 core run 已结束”与“扩展已排入 continuation”，导致 Hub 在 `turn_end` 提前结束 GUI stream、后续停止无效且确认卡片/阶段标记丢失。

**改动（最小附加字段，不修改上游 AgentEvent）**：

| 文件 | 改动 |
|------|------|
| `packages/coding-agent/src/core/agent-session.ts` | 在 `AgentSessionEvent.agent_end` 增加可选 `willContinue`；awaited extension handler 返回后，以 `willRetry || agent.hasQueuedMessages()` 计算并发送。旧消费者与测试夹具可继续省略该字段。 |

**主仓配套**：`pi_rpc_runtime.rs` 缓存最终 `TurnComplete`，以 `agent_end.willContinue` 判断是否继续保持 `Prompting`；仅最后一个 core run 的 `agent_end` 向 GUI发完成事件。取消等待中的 extension UI 时，先回 `cancelled` 释放 Promise，再发 Pi abort。

**验证**：修改后的 Pi bundle 已在主仓构建流程中成功编译；主仓 `cargo check`、`pi_rpc_runtime::tests` 通过。Pi 子模块独立 `tsc` 受当前环境 TypeScript 版本不支持 `erasableSyntaxOnly` 及 workspace 依赖未安装影响，未作为有效验证口径。

---

## 合并上游 v0.80.2（落地第8版，release_v0.80.2-8）

### 2026-06-24 | 合并上游 v0.80.2 并落地第8版

**背景**：上游 `earendil-works/pi` 发布 `v0.80.2`（原基线 `v0.79.1`，跨 12 个版本、219 commits、435 files）。按版本规则（§1.3），Pi 版本升至 `0.80.2`、自研尾号落地 `-8`（含 request_user_input 等全部自研改动）。

### 改动总览（一事一议：逐项判断上游 v0.80.2 是否已实现等价功能）

| 自研改动 | 上游 v0.80.2 状态 | 去留决策 |
|---------|------------------|---------|
| `request_user_input` 工具 + `main.ts` 注册（第8版）| 未实现（coding-agent tools 目录无此工具；`extension_ui` 仅 rpc-mode 内部协议）| **保留**（注：扩展源已于 2026-06-27 移交主仓纳管，见第 8 版该日期条目） |
| `build-bundle.mjs` 输出 `runtime-deps.json`（第6版）| 未实现（上游无 build-bundle/runtime-deps 机制）| **保留** |
| `packages/ai` build 移除 `generate-models` 卡点（第2版）| 未修复（上游 build 仍 `npm run generate-models && ...`）| **保留** |
| `husky` prepare 安全化（第1版）| 未修复（上游 prepare 仍强 husky）| **保留** |
| `pi` CLI → `jishu` 命名（第2版）| 未实现 | **保留** |
| `.publish-stage/` gitignore（第7版）| 未实现 | **保留** |
| `npm-shrinkwrap.json` | 上游有（v0.80.2 重新生成）| fork **重新生成**为 0.80.2-8（惯例同 release_v0.79.1-7），主仓 publish-pi.mjs 转 resolved |
| `trust-manager` 命名 | 上游演进：`hasProjectTrustInputs` → `hasTrustRequiringProjectResources` | **采用上游新命名**（main.ts 同步）|
| 孤立产物 `earendil-works-pi-coding-agent-0.78.1.tgz` | — | **删除**（源码无引用、v0.78.1 过时、4.7MB）|

**版本同步**：所有 `package.json`（根 + agent/ai/coding-agent/tui）version 与内部依赖统一为 `0.80.2-8`；`package-lock.json` 经 `npm install` 同步 v0.80.2 依赖树（bin `pi`→`jishu` 同步入 lock）。

**验证（2026-06-24）**：`tsc --noEmit -p packages/coding-agent/tsconfig.build.json` → 0 error；`npm-shrinkwrap.json` up to date；`build-bundle` 输出 27 runtime-deps；pre-commit 全套（biome / pinned-deps / ts-imports / shrinkwrap / tsgo / browser-smoke）通过。

**主仓配套（本次同步落地）**：`third_party/pi` 指针指向 `c07d10e0`，`.gitmodules` branch 改为 `release_v0.80.2-8`，PI_CHANGE.MD 记录本次合并。**注意**：主仓指针当前指向 fork 本地 commit，主仓发版 push 前必须先 `git push origin release_v0.80.2-8`（fork）使该 commit 在远端可达。`PI_AGENT_VERSION` 由 upgrade-version.mjs 在发版时同步。

---

## 第 8 版 (自研尾号 -8)

### 2026-06-28 | pi 扩展 UI 加 multiSelect 多选 API（加法）

**背景**：jishu-hub 交互式问答要支持「一个问题、多选项、可多选」。pi 的 ctx.ui 只有单选 select，无多选 API，扩展无法触发多选 UI。

**改动（加法，对上游合并友好）**：

| 文件 | 改动 |
|------|------|
| `packages/coding-agent/src/core/extensions/types.ts` | ExtensionUIContext 加 `multiSelect(title, options, opts?): Promise<string[] \| undefined>` |
| `packages/coding-agent/src/modes/rpc/rpc-types.ts` | RpcExtensionUIRequest 加 `method:"multiSelect"` union 成员 |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | createExtensionUIContext 加 multiSelect 实现（response.value split("\n") → string[]） |
| `packages/coding-agent/src/core/extensions/runner.ts` | noOpUIContext 加 multiSelect 兜底 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | createExtensionUIContext 加 multiSelect 兜底（fallback 单选 + warn，TUI 暂无 checkbox） |

**多值编码**：multiSelect response 复用 `{value:string}`（不新增 response 类型），value 是前端 join("\n") 的多选结果串，pi rpc-mode split("\n") 还原 string[]。

**主仓配套**：pi_rpc_runtime convert multiSelect → allow_multiple:true；request_user_input 扩展加 multi 参数 → ctx.ui.multiSelect。端到端验证通过。

### 2026-06-27 | request_user_input 扩展源移交主仓纳管（完全解耦 pi submodule）

**背景**：`request_user_input` 工具自第 8 版（c019b317）改为扩展形态后，源文件 `.pi/extensions/request-user-input.ts` 随 pi submodule 提交。但 `.pi/extensions/` 是 pi 的**项目级**扩展目录（仅当 cwd 为 pi 仓库时加载），对 jishu-hub 用户在任意 cwd 使用 pi 实际无效；文档承诺的"Hub 部署到全局 extensions 目录"此前未落地。本次彻底解耦：源文件移交 jishu-hub 主仓纳管，Hub 启动时自动部署，机制完全模仿 `jishu-task-conductor`。

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| `.pi/extensions/request-user-input.ts`（**删除**） | 扩展源移交主仓纳管，本仓库不再持有；`main.ts` 仍保持上游原样，无引用残留 |
| `docs/development-note.md`（修改） | 修正 `~/.pi/agent/extensions/` 笔误为 `~/.jishu-agent/extensions/`；新增「八、扩展源移交主仓纳管」节 |
| `packages/coding-agent/docs/request-user-input.md`（修改） | 顶部加迁移声明框；多处 `~/.pi/agent/` 笔误修正为 `~/.jishu-agent/` |

**主仓对应改动**（jishu-hub，本次同步落地）：
- `src-tauri/resources/extensions/request-user-input.ts`（**新增**）：扩展源，内容平移自本仓库原文件；编译期 `include_str!` 嵌入。
- `src-tauri/src/task_plan.rs`：抽 `deploy_extension_file` / `register_extension_in_settings` 共享辅助（conductor 与新函数复用）；`ensure_conductor_extension` 迁移到辅助并修复「settings.json 不存在则静默跳过注册」隐患；新增 `ensure_request_user_input_extension`。
- `src-tauri/src/lib.rs`：setup hook 调用 `ensure_request_user_input_extension`。

**设计依据**：pi fork 的 agent 目录为 `~/.jishu-agent`（环境变量 `PI_CODING_AGENT_DIR`，`config.ts` 的 `getAgentDir`）；`settings.json` 的 `extensions` 数组路径相对 `agentDir` 解析（`package-manager.ts:resolve`）。即便 settings 注册失败，pi 也会自动发现并加载 `~/.jishu-agent/extensions/` 下文件（`addAutoDiscoveredResources`）——双重加载兜底。扩展 `.ts` 的 import（`@earendil-works/pi-coding-agent`、`typebox`）由 pi loader 的虚拟模块解析，与磁盘位置无关，搬到主仓后无需改动。

**版本同步**：本仓库本次提交为 `release_v0.80.2-8` 的后续 commit（`1339cb80`），主仓 submodule 指针已更新指向该 commit；该 commit 已 push 到 fork `release_v0.80.2-8`，远端可达。

**验证**：主仓 Rust 改动的 `cargo check` / 单测 / 端到端待在已装 Rust 工具链的环境补跑（实现机无 Rust 工具链）。

### 2026-06-25 | jishu-task-conductor Pi 扩展（三阶段工作流驱动）+ slash command 注入旁路

**背景**：任务功能从"Hub 层脚本/事件驱动阶段推进"改为"Pi 原生扩展驱动"。Conductor 扩展在 Pi 内部确定性驱动 discuss→plan→execute 三阶段，通过 `lock_requirement` / `commit_plan` 结构化工具提交产物，`agent_end` + `ctx.ui.select` 人工关卡推进阶段。扩展随 Hub 启动自动注册到 `~/.jishu-agent/`。

**改动说明**：本次改动不涉及 Pi 子模块源码（`third_party/pi` 无修改），全部在 jishu-hub 主仓。但改动深度依赖 Pi 的扩展机制（registerCommand / registerTool / on events / ctx.ui.select / appendEntry），且解决了 Pi RPC 模式下的 slash command 与 abort 兼容问题，故记录于此。

| 模块（主仓） | 改动说明 |
|------|---------|
| `src-tauri/resources/extensions/jishu-task-conductor.ts`（**新增**） | Pi 扩展，驱动三阶段工作流。核心机制：`registerCommand("jishu-task")` 启动命令；`registerTool("lock_requirement")` / `registerTool("commit_plan")` 结构化提交工具；`on("before_agent_start")` 按 (domain, phase) 注入 skill pack 方法论；`on("context")` 过滤旧阶段注入；`on("agent_end")` + `ctx.ui.select` 人工关卡（Hub 通过 `extension_ui_request` → `InteractionRequest` 渲染弹窗）；`on("tool_call")` 白名单兜底拦截；`on("session_start")` + `appendEntry` 断点恢复。`on("turn_end")` 检测 `stopReason === "aborted"` 避免用户停止后 `agent_end` 阻塞 Pi。 |
| `src-tauri/resources/task-plan/jishu-conductor-dev/`（**新增**） | dev 领域 skill pack（discuss / plan / execute 三阶段方法论 markdown），被 Conductor 按 phase 注入。 |
| `src-tauri/src/agent/mod.rs` | `ResolvedSessionPromptInjection::apply()` 新增 slash command 旁路：消息以 `/` 开头时跳过 `<jishu-runtime-context>` 注入。**根因**：Pi 的命令分发器仅在消息首字符为 `/` 时触发（`agent-session.ts:1005`），Hub 的 runtime context 注入把 `<jishu-runtime-context>...` 放在消息前面，导致 `/jishu-task` 被当普通文本而非 Pi 命令。 |
| `src-tauri/src/task_plan.rs` | 新增 `ensure_conductor_extension()`：Hub setup hook 调用，自动将扩展 .ts + skill pack 写入 `~/.jishu-agent/`，幂等注册 `settings.json` extensions，删除旧 `jishu-task-planner` skill（避免 agent 读旧 skill 干扰）。 |
| `src-tauri/src/lib.rs` | setup hook 调用 `ensure_conductor_extension()`；注释 `install_builtin_skill("jishu-task-planner")`（旧 skill 被 Conductor 取代）。 |

**设计依据**：
- Pi 扩展机制（`ExtensionAPI` / `ToolDefinition` / 事件钩子）全部来自 `types.ts`，已逐行核实源码。`ctx.ui.select` 在 RPC 模式下通过 `extension_ui_request` 协议传给 Hub，Hub 的 `convert_extension_ui_request`（`pi_rpc_runtime.rs:885`）已对接 select/input → `InteractionRequest`。`ctx.ui.confirm` 不映射（L943 `_ => None`），故 Conductor 统一用 `select`。
- slash command 旁路的根因定位：Pi `agent-session.ts:1005` 检查 `message[0] === '/'`；Hub `apply()` 把 `<jishu-runtime-context>` 放在前面，破坏了这个前提。
- abort 兼容：Pi 的 abort 流程是 `turn_end(stopReason="aborted") → agent_end`。`turn_end` 在 abort 时也会触发，Conductor 通过检查 `stopReason` 区分正常完成 vs abort，避免 `agent_end` 里 `ctx.ui.select()` 阻塞 Pi 导致"停止后继续输出"。

**验证**：`/jishu-task dev "实现一个登录功能"` 端到端测试通过——discuss 阶段 `request_user_input` 提问 → `lock_requirement` 工具提交需求 → `ctx.ui.select` 弹窗确认 → plan 阶段 `commit_plan` 工具提交计划 → 确认弹窗 → 产物落盘 `.jishu-hub/tasks/<task_id>/artifacts/`。停止按钮测试通过（abort 不再阻塞）。

### 2026-06-14 | 新增 `request_user_input` 内置工具（Jishu Agent 规划阶段暂停-续跑）

**根因与背景**：Jishu Hub 任务编排的规划阶段（Jishu Agent / Pi planner）需要中途暂停向用户提问（选方案/补充信息），用户回复后同一 turn 继续。此前 Pi 无 `request_user_input` 工具，LLM 调用后 Pi tool runner 报错"未知工具"。方案 B：复用 Pi 已有的 `extension_ui_request` / `extension_ui_response` 协议（RPC 模式已实现），注册一个 `request_user_input` customTool，execute 内调 `ctx.ui.select` / `ctx.ui.input` 触发 extension_ui 暂停，Hub 收到 request 后转 `NormalizedEvent::InteractionRequest`，用户回复后 Hub 发 `extension_ui_response` → Pi 工具拿到结果 → LLM 同一 turn 继续。

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| `packages/coding-agent/src/core/tools/request-user-input.ts`（**新增**） | 定义 `requestUserInputTool`（`defineTool`），参数 `{question: string, options?: string[]}`，execute 内：有 options → `ctx.ui.select(question, options)`，无 → `ctx.ui.input(question)`；返回 `{content: [{type:"text", text: response}], details: undefined}`。工具在 agent loop 中自然暂停（ui.select/input 是阻塞 Promise，等 extension_ui_response）。 |
| `packages/coding-agent/src/main.ts` | 导入 `requestUserInputTool`；在 `createAgentSessionFromServices` 调用的 `customTools` 参数追加该工具（`customTools: [...(sessionOptions.customTools ?? []), requestUserInputTool]`）。仅 RPC 模式（Hub 启动 Pi 用 `--mode rpc`）。 |

**设计依据**：Pi RPC 模式（`modes/rpc/rpc-mode.ts`）已完整实现 `extension_ui` 协议——`createExtensionUIContext` 的 `select`/`confirm`/`input` 方法发出 `extension_ui_request`（stdout JSON）+ 阻塞等 `extension_ui_response`（stdin JSON）。本工具复用此机制，不新增协议。`customTools` 是 Pi AgentSession 的既有扩展点（`CreateAgentSessionFromServicesOptions.customTools: ToolDefinition[]`），无需修改核心架构。工具仅在 LLM 主动调用时生效，不影响其他能力。

**Hub 侧配套改动**（主仓 `src-tauri/src/pi_rpc_runtime.rs` + `acp_runtime.rs`，详见主仓提交 8e91546）：
- `AcpCommand` 新增 `RespondToInput{id, value}`；`AcpControl` 新增 `respond_to_input(id, value)`。
- `pi_rpc_connection_loop`：检测 `extension_ui_request` 事件 → `convert_extension_ui_request` 转 `NormalizedEvent::InteractionRequest`（select→选项+单选，input→自定义文本）；处理 `RespondToInput` → 发 `extension_ui_response` 到 Pi stdin。

**验证**：`npx tsc --noEmit -p packages/coding-agent/tsconfig.build.json` → 0 error。Hub 侧 321 Rust 单测 + 3 架构回归全绿。端到端暂停-续跑需在 Tauri 桌面应用中手动验证（Pi 发 extension_ui_request → Hub 转 InteractionRequest → 前端展示 → 用户回复 → Hub 发 extension_ui_response → Pi 继续）。

## 第 7 版 (自研尾号 -7)

### 2026-06-12 | 修复 Lite 发布版 npm-shrinkwrap.json 转换 bug（别名依赖 404 → Lite 对话卡死）

**根因与背景**：-6 版发布的 `@jishu-hub/jishu-agent@0.79.1-6`（Lite）启动对话时卡在 "thinking" 无响应，根因是 `publish-pi.mjs` 里**新加的 shrinkwrap 转换逻辑**（提交 `46d6766`，-6 时期引入、此前未入档）有两处致命错误，导致包内的 `npm-shrinkwrap.json` 让 3 个内部别名依赖一个都装不上，MCP 扩展 `import '@earendil-works/pi-agent-core'` 找不到包而崩：

1. **Phase 1 形同空操作**：拼 shrinkwrap key 时误用 `SCOPE_OLD.slice(1)` 去掉了 `@`（得到 `earendil-works` 而非 `@earendil-works`），与真实 key `node_modules/@earendil-works/pi-*` 永远匹配不上 → key 重命名与 `resolved` 重写从未生效。
2. **Phase 2 双重错误**：
   - **key 被错改名**：`node_modules/@earendil-works/pi-agent-core` → `node_modules/@jishu-hub/jishu-agent-core-core`。但发布版 `package.json` 的别名 key 是 `@earendil-works/pi-agent-core`（npm 据此装到 `node_modules/@earendil-works/pi-agent-core`）。shrinkwrap key 与别名 key 对不上 → npm 在 shrinkwrap 里查不到该条目 → 当作新依赖去 registry 解析 `@earendil-works/pi-agent-core@0.79.1-6` → fork 从不发布该名 → **404**。4 个内部包全部中招。
   - **double-core**：`pi-agent` 是 `pi-agent-core` 的前缀，Phase 2 的全局字符串替换把 `@earendil-works/pi-agent-core` 变成 `@jishu-hub/jishu-agent-core-core`（同样 404）。

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| `scripts/publish-pi.mjs`（主仓） | **重写 shrinkwrap 转换逻辑**。核心原则：别名机制下 npm 把每个内部包装在 `node_modules/@earendil-works/pi-X`（别名 key 决定安装位置），因此 shrinkwrap 的 **package key 必须保持 `@earendil-works/*` 原样不动**——唯一要改的是内部包的 `resolved` 字段：上游 `generate-coding-agent-shrinkwrap.mjs` 把它指向 `@earendil-works/*` tarball（fork 从不发布），改指向别名真正解析到的 `@jishu-hub/*` tarball。其余字段（key、integrity、**经审计的外部依赖树**）原样继承，保住上游的供应链硬化。映射改为按 **npm 包名**（非目录名），杜绝 `pi-agent` vs `pi-agent-core` 的前缀误配。新增**守卫断言**：若任何 key 被误改成 `@jishu-hub/*` 直接抛错，防止本 bug 回潮。 |

**设计依据**：查阅上游 `earendil-works/pi`，其 `packages/coding-agent/npm-shrinkwrap.json` 是**刻意随包发布的供应链硬化产物**（由 `scripts/generate-coding-agent-shrinkwrap.mjs` 生成，带依赖白名单 + install-script 审计 + 完整性校验），上游文档明确其"overrides any lockfile behavior during npm install for end users"。故本修复选择**保留并正确转换** shrinkwrap（仅改 `resolved`），而非丢弃（丢则失去间接依赖锁定）或全量重生成（`npm install --package-lock-only` 会丢掉上游的审计裁剪）。fork 需要转换是因为它以 `@jishu-hub/*` 别名重发，而上游以本名 `@earendil-works/*` 发布、shrinkwrap 名字天然正确无需转换。

**验证（2026-06-12，端到端本地模拟）**：`npm pack` 出发布原物 tarball（`npm notice` 确认内含修正后的 `npm-shrinkwrap.json` 60.7kB）→ 干净临时目录 `npm install` → 3 个别名内部包（pi-agent-core / pi-ai / pi-tui）正确落到 `node_modules/@earendil-works/`，共 133 包无报错；`cli.js --version` 输出 `0.79.1-6`；pi-agent-core 为真包（`@jishu-hub/jishu-agent-core@0.79.1-6`，main `./dist/index.js`，非空壳）。全局安装该 tarball 后 `tauri dev` 实际对话恢复正常（用户确认）。注：`pi-coding-agent` 不在自身 shrinkwrap 的依赖里（它是 root 包），故只有 3 个被引用的内部包需要转换。

## 第 6 版 (自研尾号 -6)

### 2026-06-11 | 统一 Full/Lite 构建流水线：build-bundle 输出运行时依赖清单（runtime-deps.json）

**根因与背景**：Full（主仓 `pack-pi.mjs`）与 Lite（主仓 `publish-pi.mjs`）历史上是两套独立脚本，各自维护运行时依赖集合。本仓库的 `build-bundle.mjs` 内部其实已计算出 esbuild 需要 externalize 的依赖，但结果从未导出，导致 publish-pi.mjs 不得不在主仓**重新推导**一份（不完整），pack-pi.mjs 则靠 workspace 全量安装**掩盖**了缺失。三方各自为政，漂移使 Lite 连环翻车（缺 provider SDK → `ERR_MODULE_NOT_FOUND`；双 shebang → Node `SyntaxError`）。本次把 build-bundle 计算出的依赖集落盘为清单，作为 Full/Lite 唯一共同的依赖真相。

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| `packages/coding-agent/build-bundle.mjs` | esbuild 构建后**新增输出 `dist/runtime-deps.json`**，记录所有被 externalize 的非 `@earendil-works` 运行时依赖（名称→版本；同一依赖在多包出现时取最高 semver，与 npm 解析一致）。esbuild 的 `external` 列表改为由该清单的键派生，保证“打包时 external 的”与“清单声明的”永远一致。 |

**消费该清单的主仓配套改动（跨仓引用，详见主仓 `PACKAGING.md` §4）**：

- `scripts/lib/pi-common.mjs`（新增）：共享 `fixShebang()`（消除双 shebang）与 `readRuntimeDeps()`（读取清单），Full/Lite 共用同一实现。
- `scripts/pack-pi.mjs`（Full）：打包末尾**断言**清单中每个依赖都物理存在于 `pi-bundle/node_modules`，缺失即构建失败、大声报错——取代过去被 workspace 安静掩盖的行为。
- `scripts/publish-pi.mjs`（Lite）：把清单中的依赖**声明**进发布的 `package.json` 的 `dependencies`，由用户 `npm install` 时拉取——取代主仓内重新推导依赖集的旧逻辑。

**验证（2026-06-11，端到端）**：清单含 25 个运行时依赖，覆盖全部 provider SDK（`openai`、`@anthropic-ai/sdk`、`@google/genai`、`@mistralai/mistralai`、`@aws-sdk/client-bedrock-runtime`、`@smithy/node-http-handler` 等）。Full 断言通过（“All 25 runtime dependencies present”），Lite 暂存的 `package.json` 0 缺失，打包产物 `cli.js --version/--help` 均正常。Full/Lite 现共享同一份 esbuild 产物、同一份清单、同一 shebang 处理，结构上不再可能漂移。

### 2026-06-11 | 将 `.publish-stage/` 移出版本控制（gitignore）

**根因与背景**：`packages/*/.publish-stage/` 是主仓 `publish-pi.mjs` 发布时**清空重建**的临时 staging 目录（每次 `npm publish` 前 `rmSync` + `mkdirSync` 重做），属纯临时产物。但历史上它被提交进了 fork，导致每次升版本后 `.publish-stage/*` 快照都停留在旧版本——本次升 0.79.1-6 时，3 个 package.json 仍停在 0.79.1-5，且 coding-agent 快照还缺第6版新增的 11 个 provider/网络依赖，制造“仓库里有一份旧/残缺草稿”的误导。npm registry 本身就是“发布了什么”的权威来源，git 里再存一份既冗余又必然漂移。

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| `.gitignore` | 新增 `.publish-stage/`（匹配任意层级的同名目录）。 |
| `packages/*/.publish-stage/` | `git rm -r --cached` 移除已跟踪的 9 个文件（4 个包各 `README.md` + `package.json`，外加 coding-agent 的 `npm-shrinkwrap.json`）；工作树副本一并清理，发布时由 `publish-pi.mjs` 现场重生成。 |

**验证**：全仓 grep 确认除 `publish-pi.mjs`（写入方）与 `PACKAGING.md`（文档）外，无任何代码/测试把 `.publish-stage` 当数据读；husky pre-commit 全套检查（biome / pinned-deps / ts-imports / shrinkwrap / tsgo / browser-smoke）通过。此后升版本不再需要同步 `.publish-stage`，从结构上消除该漂移源。

## 第 3 版 (自研尾号 -3)

### 2026-06-10 | 修复内部依赖锁定错误与硬编码版本显示

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| 全局版本同步 | 由于发布 `-2` 版本时遗漏了根目录 `package.json` 的版本更新，导致 npm 别名发布脚本将内部依赖错误地指回了旧版，导致实际执行包损坏。此版本利用新的 `upgrade-version.mjs` 脚本实现了跨全仓库（包括 Rust 后端的 `PI_AGENT_VERSION`、所有子包以及脱机资源包）的 100% 同步升级至 `0.79.1-3`。 |

## 第 2 版 (自研尾号 -2)

### 2026-06-10 | 同步上游开源库版本 v0.79.1

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| 全局 | 同步上游 `v0.79.1` 最新代码，顺延保持 Jishu Hub 的自研特例逻辑（如移除 husky 依赖、去除 generate-models 构建卡点、以及将全局 `pi` CLI 命令重命名为 `jishu`）。 |
| 版本号 | 将各个内部包的 version 从 `0.78.1-2` 升级至 `0.79.1-2`。 |

### 2026-06-09 | NPM Alias 无侵入式发布架构升级

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| 打包发布机制 | **重大架构升级**：彻底废弃了在源码层面通过 Regex 批量替换 `@earendil-works` 为 `@jishu-hub` 的方案。因为这种方式破坏了与上游的同步兼容性。**新方案采用了 NPM 官方的 Alias（别名映射）机制**，保证本地所有的 TypeScript 源码 100% 保持上游原样（0 冲突），仅在 `scripts/publish-pi.mjs` 发布时刻，在临时目录的 `package.json` 中配置 NPM 原生别名。此版本（0.78.1-2）是首个完全无侵入、源码级 100% 兼容上游开源库发布的纯净版本！ |
| `packages/ai` | 移除了 `package.json` 中 `build` 阶段绑定的 `generate-models` 脚本。因为该脚本依赖海外网络获取最新大模型 API 数据，网络超时会导致编译所需的类型文件残缺（如缺少 nvidia 等 provider），从而直接导致后续的 NPM Publish 彻底失败。现恢复使用 git 历史中完好的模型结构文件以保证持续集成的稳定性。 |

## 第 1 版 (自研尾号 -1)

### 2026-06-08 | 原生 Node.js 版本兼容性适配

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| `package.json` | 移除了强制要求的 `husky` 钩子报错逻辑。将 `"prepare": "husky"` 替换为忽略错误的方式，解决在用户机器部署时由于缺少 husky 依赖导致整个 npm 安装失败的问题。 |

## 2026-06-07 | 迁移至原生 Node.js 版本的 Pi

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| Jishu Agent 集成方式 | 移除 `pi_agent_rust`，改为通过 `git submodule` 引入原生的 `wang5766171/pi@0.78.1` |
| 运行方式 | 放弃构建内嵌的 `pi.exe`，转为依赖用户机器环境中的 Node.js 运行捆绑下发的 Javascript 代码 |

**上游基线**：`v0.78.1` tag

**改动背景**：
之前由于 `pi_agent_rust` 是参考原生 Pi 的 Rust 版本移植，并没有经过详细的调研，导致其能力（如 MCP 服务扩展支持）与原生 Node 的 Pi 存在差异。因此决定切换回原生项目以确保后续代码技术匹配及各项能力的完整支持。
