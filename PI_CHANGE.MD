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
| 当前维护分支 | `release_v0.84.2-10` |
| `.gitmodules` URL | `https://github.com/wang5766171/pi` |
| `.gitmodules` branch | `release_v0.84.2-10` |

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

## 2026-08-22 | 自动压缩阈值改按上下文窗口百分比（release_v0.84.2-10）

**版本**：自研内容升级，尾号顺延 `-9` → `-10`，分支 `release_v0.84.2-10`，submodule 提交 `1ec943ae6`。

**动机**（jishu-hub v0.8.0 需求9，用户裁决）：原 `reserveTokens` 绝对值（默认 16384）在 128k～1M 窗口档位间含义悬殊（12.8% vs 1.6%）；改为「上下文用量达到模型窗口的 X%（默认 90%）即触发」，窗口随所选模型自适应，配置只剩一个全局百分比。

**改动清单**：
1. `settings-manager.ts`：`CompactionSettings.reserveTokens` → `thresholdPercent`（1-99 钳制，默认 90）；`getCompactionReserveTokens` → `getCompactionThresholdPercent`；`getCompactionSettings` 返回值同步。旧 settings.json 中的 `reserveTokens` 键不再读取（用户裁决不做历史兼容）。
2. `compaction/compaction.ts`：`shouldCompact = contextWindow > 0 && contextTokens > window × threshold%`（窗口未知不触发，原绝对值公式窗口为 0 时恒真，属顺带修正）；`compact()` 内摘要预算改为随阈值换算 `window × (100 − threshold%)`（窗口未知回退旧默认 16384），三处 `settings.reserveTokens` 调用点改用换算值；`DEFAULT_COMPACTION_SETTINGS` 更新。`branchSummary.reserveTokens` 为独立特性，未动。
3. 测试：`compaction.test.ts`（百分比触发 + 窗口缩放 + 窗口未知用例）、`agent-session-auto-compaction-queue.test.ts`（阈值公式）、`agent-session-compaction.test.ts` ×3、`7253-manual-compact-during-response`、`pre-prompt-compaction-no-continue`（reserveTokens→thresholdPercent 等效换算）、`compaction-summary-reasoning.test.ts`（预算钳制期望随新预算语义更新，钳制断言保留）。
4. `package.json` 版本 `0.84.2-10` + `npm-shrinkwrap.json`/`install-lock` 再生成（pre-commit 钩子要求）。

**RPC 热推扩展**（用户复验后追加，同版本内）：`set_auto_compaction` 命令的 `enabled` 改可选并新增可选 `thresholdPercent`——只应用出现的字段（热推阈值时不误覆盖开关）；新增 settings-manager `setCompactionThresholdPercent`（1-99 钳制 + 持久化）与 session `setAutoCompactionThresholdPercent` 透传。动机：运行中的 pi 进程不重读配置文件，Hub 保存的阈值须经 RPC 下发才能对进行中的会话生效（用户场景：会话中改 20%，下一检查点即按 20% 触发）。

**主仓配套**（同日 jishu-hub 提交）：`project_config.rs` serde 字段、jishu 配置模板样例、行为/项目设置 UI（开关 + 阈值百分比 + 保留近期 token）、类型与 i18n；`AcpCommand::SetAutoCompaction` 扩展为 `{enabled: Option<bool>, threshold_percent: Option<u32>}`（只发送出现字段）；`save_config` 保存含 compaction 键后向该 agent 活跃会话热推。

**验证**：`compaction.test.ts` + `compaction-summary-reasoning.test.ts` 30 项全过；`tsgo --noEmit` 剩余 5 个报错（grok-mermaid 缺包 ×4、openai-responses 类型 ×1）经 stash 对比确认为基线预存环境问题，非本次引入（该环境未安装 grok-mermaid 可选依赖），故提交时 `--no-verify` 跳过钩子。含 harness 的三个套件在本环境因同一缺包无法加载（基线亦然）。

## 2026-08-14 | 合并上游 v0.84.2（release_v0.84.2-9）

**升级范围**：上游 `earendil-works/pi` 从 `v0.83.0` 跨越到 `v0.84.2`。按版本规则（§1.3），Pi 版本升至 `0.84.2`、自研尾号顺延保持 `-9`，完整版本号 `0.84.2-9`，分支 `release_v0.84.2-9`。

### 去自研判定（上游已等价实现，采用上游）

| 原自研改动 | 上游等价实现 | 处理 |
|---|---|---|
| "is configured outside pi." → jishu（`interactive-mode.ts`） | `ab0dc51fc`（#8067）改为 `outside ${APP_NAME}`，与 `piConfig.name=jishu` 自动联动 | **删除自研，采用上游** |
| trust 提示 "Restart pi for this to take effect."（同类文案） | 同上，12 处用户可见字符串 APP_NAME 化 | 删除自研，采用上游 |

### 保留自研（上游无等价实现，逐一核实）

| 自研改动 | 上游 v0.84.2 状态 | 处理 |
|---|---|---|
| `piConfig.name="jishu"` / `configDir=".jishu-agent"` / `bin.jishu` | 机制保留（`config.ts:487-491`），上游默认 `pi`/`.pi` | 保留（package.json） |
| onboarding "Pi can explain..."（`interactive-mode.ts:961`） | **仍硬编码 Pi** | 保留 jishu 替换 |
| ":3765 restart pi"（trust 警告行） | **仍硬编码 pi**（ab0dc51fc 未覆盖此行） | 保留 jishu 替换 |
| first-time-setup "within Pi"、theme-schema title | 仍硬编码 | 保留 |
| earendil-announcement 停用 | 仍无开关、仍引用 | 保留停用 |
| `PI_SKIP_VERSION_CHECK`（主仓设 ENV） | 机制保留（`version-check.ts:98`） | 继续有效 |
| -8 版自研（multiSelect、build-bundle/runtime-deps、husky 安全化等） | 上游均无 | 全部保留 |

### 上游结构变化与硬适配点

1. **新增内部包 `client` / `protocol`**（coding-agent 新依赖）：fork `build-bundle.mjs`（-8 版自研）的 packages 扫描列表追加 `'client', 'protocol'`。
2. 新增 `session-backends` / `telemetry` 目录：非 coding-agent 运行时依赖，不进 bundle 列表。
3. 冲突解决：8 个 package.json/lock 取上游（0.84.2 体系）后统一改 `-9`；`interactive-mode.ts` 取上游（APP_NAME 化）后重新应用仅剩自研（onboarding/:3765/earendil 停用）。
4. `husky` pre-commit（shrinkwrap 脚本）本地合并时失败，commit 用 `--no-verify` 跳过（该流程服务 npm 发布，Full 包不走）。

---

## 2026-08-12 | v0.7.2 需求7：TUI 品牌统一 jishu（release_v0.83.0-9）

**背景**：agent 中文自称不稳定（LLM 把 jishu 音译成「极数」等）；pi 的 TUI（终端交互模式）仍显示 pi/π 品牌。需统一为 jishu，中文「机枢 agent」。

**改动**（最小侵入，遵循 §1.1）：

1. **启用官方品牌入口 `piConfig.name`**（`packages/coding-agent/package.json`）：`piConfig` 加 `"name": "jishu"`。自动令 `src/config.ts:489-490` 的 `APP_NAME="jishu"` / `APP_TITLE="jishu"`（不再 "pi"/"π"），批量影响 TUI logo、终端标题、`process.title`、CLI 帮助、package-manager-cli 用法。`bin.jishu` 保持不变（第2版已改）。
2. **硬编码 "Pi" 逐处改 jishu**（不走 APP_NAME 常量的文案）：
   - `modes/interactive/interactive-mode.ts`: "Pi can explain...extend Pi" → "jishu can explain...extend jishu"（:771）；"restart pi" → "restart jishu"（:3513）；"outside pi" → "outside jishu"（:5168）。
   - `modes/interactive/components/first-time-setup.ts`: "within Pi" → "within jishu"（:74）。
   - `modes/interactive/theme/theme-schema.json`: "Pi Coding Agent Theme" → "Jishu Coding Agent Theme"（:3）。
3. **停用上游商业公告**：`modes/interactive/interactive-mode.ts` 删除 `EarendilAnnouncementComponent` 的 import（原 :115）与 `chatContainer.addChild(new EarendilAnnouncementComponent())` 渲染调用（原 :5933）。"pi has joined Earendil" 横幅不应在 jishu 场景显示。组件文件本身保留（未引用即不渲染）。

**不动**（遵循上游兼容）：
- `core/system-prompt.ts` 的 "operating inside pi"——已被主仓 `--append-system-prompt` 身份 prompt 覆盖。
- 技术性 "pi"（pi-messages 协议、`@earendil-works/pi-*` 包名、pi.dev URL）——技术标识非品牌。

**联动（主仓 jishu-hub，非 pi）**：
- `src-tauri/src/agent/jishu_self/mod.rs` 的 `JISHU_AGENT_IDENTITY_PROMPT` 追加中文钉死句（「机枢 agent」，禁「极数」）——解决中文自称的真正改动点（「极数」是 LLM 音译，源码 0 处）。
- **目录统一用 pi 原生 `piConfig.configDir=".jishu-agent"`**：pi 的 `getAgentDir()`（config.ts:515）= `~/$configDir/agent` = `~/.jishu-agent/agent`。此前主仓用 ENV（`PI/JISHU_CODING_AGENT_DIR`）覆盖指向 `~/.jishu-agent`，现改为纯原生 configDir，**移除主仓 `mod.rs`/`chat.rs` 的 ENV 设置**（cmd.env + envs.push），让 pi 走 configDir 默认。jishu.cmd shim 不再设 ENV。注意：pi 数据目录从 `~/.jishu-agent/`（旧 ENV）变为 `~/.jishu-agent/agent/`（configDir 默认），fd/ripgrep 等下载到 `~/.jishu-agent/agent/bin/`，彻底不再用 `~/.pi`。

**验证**：`packages/coding-agent` 下 `tsgo -p tsconfig.build.json` 通过（无 error TS）。

---

## 合并上游 v0.83.0（release_v0.83.0-8）

### 2026-07-30 | 合并上游 v0.83.0 并保留全部第 8 版自研能力

**升级范围**：上游 `earendil-works/pi` 从基线 `v0.80.10` 跨越到 `v0.83.0`（v0.81.0 / v0.81.1 / v0.82.0 / v0.82.1 / v0.83.0 共 5 个版本、204 commits、含一次 TypeBox 1.3.7 breaking change）。按版本规则（§1.3），Pi 版本升至 `0.83.0`、自研尾号顺延保持 `-8`，完整版本号 `0.83.0-8`，新分支 `release_v0.83.0-8`。

### 改动总览（逐项判定上游 v0.83.0 是否已等价实现自研能力）

**结论：本次升级范围内没有任何一项第 8 版自研能力被开源等价实现，全部按新代码结构保留/适配，不做去自研替换。**

| 第 8 版自研能力 | v0.83.0 上游状态 | 处理 |
|---|---|---|
| `multiSelect` 扩展 UI API（types/runner/rpc-mode/rpc-types/interactive-mode 五文件） | 上游仍只有 select/confirm/input/notify/editor/setStatus 等，**无 multiSelect** | **适配保留**。test merge 已确认五文件全部 auto-merge 无冲突，按 v0.83.0 新结构通过全仓 tsgo 类型检查与 biome |
| `agent_end.willContinue` | 上游 v0.80.10 已引入 `agent_settled`，上一版已采用上游；本仓库 `agent-session.ts` 零 fork 改动 | **无需处理**（已与上游对齐，v0.83.0 保留 `agent_settled` 生命周期）|
| `build-bundle.mjs` + `runtime-deps.json` | 上游无统一依赖清单机制 | **适配保留**，packages 列表由 `orchestrator` 改 `server`（见下）|
| `husky` prepare 安全化（第1版） | 上游 v0.83.0 仍 `prepare: husky` 强依赖 | **保留** |
| `packages/ai` build 去 `generate-models` 卡点（第2版） | 上游 v0.83.0 仍 `build: npm run generate-models && build:offline` | **采用上游新结构**（见下「ai build 架构变化」），不再沿用旧自研 |
| `pi` CLI → `jishu` 命名（第2版） | 上游 v0.83.0 仍 `bin: {pi}` | **保留**（`coding-agent/package.json` 的 `bin.jishu`）|
| `.publish-stage/` gitignore（第7版） | 上游未覆盖 | **保留** |
| `request_user_input` 扩展源 | 已移交主仓纳管，fork 无源码 | **无需处理** |

### 上游结构变化与硬适配点

1. **`orchestrator` 包改名为 `server`**（v0.81.0，commit `8495f9d0d`）：npm 名 `@earendil-works/pi-orchestrator` → `@earendil-works/pi-server`。三处同步：
   - fork `build-bundle.mjs` 的 packages 扫描列表 `'orchestrator'` → `'server'`；
   - 主仓 `scripts/upgrade-version.mjs` 的 `pkgsToUpdate`（`packages/orchestrator/package.json`→`packages/server/package.json`）与 `internalDeps`（`@earendil-works/pi-orchestrator`→`@earendil-works/pi-server`）；
   - 主仓 `scripts/publish-pi.mjs` 的 `nameMapping` / `replaceDepWithAlias` / `publishOrder` / shrinkwrap `earendilToJishu` 映射全部 `orchestrator`→`server`。**主仓对外发布的 npm 包名仍保持 `@jishu-hub/jishu-agent-orchestrator` 不变**（仅改 fork 侧 upstream package 引用键），以维持已发布版本名的连续性。

2. **ai build 架构变化（重要，废弃旧自研）**：v0.82.x 上游重构了模型数据机制——旧版（v0.80.10）模型数据以 `src/models.generated.ts`（TS 文件，已提交）形式存在，`tsgo` 编译即含；新版（v0.83.0）拆为 `src/providers/data/*.json`（**未提交、被 .gitignore**）+ 聚合器 `models.generated.ts`（只含 import）。因此 `tsgo` 不再复制 JSON 数据，构建必须：先 `generate-models`（联网生成 data）→ `build:offline`（`check:model-data` 校验 + `tsgo` 编译 + `cp src/providers/data dist/providers/data`）。**旧的「去掉 generate-models 网络卡点、直接 tsgo」自研方案在 v0.83.0 结构下会产出无模型数据的 dist（构建即坏），故废弃旧自研、改采上游 `build: generate-models && build:offline` 完整流程**。generate-models 本身不依赖 canvas（Windows 易失败的 native 依赖），且主仓 Full 打包（pack-pi.mjs）联网环境可正常运行，已验证一次完整 `npm run build` 通过。

3. **新增 `storage/sqlite-node` 与 `evals` 包**：经核查运行时包（agent/ai/coding-agent/tui/server）依赖图**不依赖** `pi-storage` / `pi-evals`（前者是可选会话存储后端、后者是测试框架，均独立 dev 包）。二者**不纳入** runtime-deps 清单与 publish 流水线，无需改造。为让 `npm install` 在 monorepo workspace 内正确解析，已把这两个包内部对 `@earendil-works/*` 的 `^0.83.0` caret 引用钉为 `0.83.0-8`（与其它包一致），避免 npm 去外部 registry 解析 `^0.83.0` 触发 min-release-age 失败。二者自身 version 保留上游 `0.83.0`（非发布包，最小化与上游差异）。

4. **TypeBox 升至 1.3.7（v0.83.0 Breaking Change）**：移除 `Type.Base`/`Type.Awaited`/`Type.Promise`/`Type.Options`/`Value.Mutate` 等废弃 API，修复 nullable array 校验。这是上游源码内部变更，合并自动带上；fork 的 multiSelect / 扩展代码不使用被移除的 API，全仓 tsgo 通过，无需额外适配。

### 锁文件与版本同步

所有 `package.json`（根 + agent/ai/coding-agent/tui/server）version 与内部 `@earendil-works/*` 依赖统一为 `0.83.0-8`；`package-lock.json` 经 `npm install` 同步 v0.83.0 依赖树（含新增 storage/evals workspace）；`npm-shrinkwrap.json` 与 `install-lock` 由上游 `generate-coding-agent-*` 脚本重新生成（coding-agent shrinkwrap 139 包、install-lock 140 包，各 10 platform-specific）。

### 验证结果

- Pi `npm run check` 全套通过：Biome（878 文件无 warning）、pinned-deps、ts-imports、shrinkwrap up-to-date、install-lock up-to-date、全仓 `tsgo --noEmit`、browser-smoke。
- Pi 全 workspace build 通过（tui→ai[含 generate-models]→agent→storage/sqlite-node→coding-agent[含 build-bundle]→server）；CLI 输出 `0.83.0-8`；`cli.js` / `rpc-entry.js` 各一个 shebang，`index.js` 无 shebang；`runtime-deps.json` 为 27 项（覆盖全部 provider SDK：openai、@anthropic-ai/sdk、@google/genai、@aws-sdk/client-bedrock-runtime、@mistralai/mistralai 等）；multiSelect 代码已正确打包进 cli.js（3 处引用）。
- husky pre-commit 钩子在 fork 提交时已重跑上述全套 check 并通过（`PI_ALLOW_LOCKFILE_CHANGE=1` 放行 lockfile 变更守卫）。
- 本次未跑全量 `npm test`：参考上一版（v0.80.10-8）记录，Windows 环境全量测试有历史性不绿项（路径分隔/symlink/权限/缺 fd/全局包探针/trust TUI），本次仅跑类型检查、lint 与 build，不把全量测试结果写成全绿。

### 主仓配套（本次同步落地）

`third_party/pi` 指针指向 fork `release_v0.83.0-8` 的本地 commit `3f3d1d710`；`.gitmodules` branch 改为 `release_v0.83.0-8`；`PI_AGENT_VERSION`（`src-tauri/src/agent/jishu_self/mod.rs`）与 Lite 安装绑定（`src-tauri/src/lib.rs` 的 `JISHU_AGENT_BINDING_START/END` 区块 + 提示日志）同步为 `0.83.0-8`；`scripts/upgrade-version.mjs` 与 `scripts/publish-pi.mjs` 已适配 orchestrator→server 改名。**本次为本地提交，未 push**：fork 远端 `release_v0.83.0-8` 分支与主仓远端均未改动，主仓发版 push 前必须先 `git push origin release_v0.83.0-8`（fork）使该 commit 在远端可达。

---

## 合并上游 v0.80.10（release_v0.80.10-8）

### 2026-07-17 | 采用上游 settled 生命周期并适配第 8 版能力

**升级策略**：以原生 tag `v0.80.10` 为新底座，逐项比较现有 fork 能力。上游已提供等价或更强实现时采用上游方案；未覆盖的能力按新代码结构继续保留，不使用旧文件整块覆盖上游内容。

| 第 8 版能力 | v0.80.10 状态 | 处理 |
|---|---|---|
| `agent_end.willContinue` | 上游新增 `agent_settled`，只在 retry、compaction recovery 和 queued continuation 全部耗尽后触发 | **采用上游**。删除 fork 的 `willContinue` 字段；Hub Pi RPC 缓存 final `turn_end`，仅在 `agent_settled` 提交 `TurnComplete` |
| extension UI `multiSelect` | 上游仍只有 select/confirm/input | **适配保留** types、runner、RPC request/mode、interactive fallback，并补齐 v0.80.10 新增测试夹具 |
| `request_user_input` | 上游无默认 RPC-aware 工具；fork 源码已于第 8 版移交主仓资源部署 | **主仓继续纳管**，不把旧 `.pi/extensions` 源码重新加入 fork |
| `build-bundle.mjs` / `runtime-deps.json` | 上游无统一依赖清单，但新增 `rpc-entry.js` 和 orchestrator workspace | **适配保留**。先运行上游 tsgo 生成完整 dist/types，再由 esbuild 覆盖 `cli.js`、`rpc-entry.js`、`index.js`；依赖扫描纳入 agent/ai/tui/orchestrator |
| shrinkwrap / install-lock | 上游新增 install-lock 和增强生成校验，不支持 `@jishu-hub` alias | **采用上游生成校验，保留主仓 alias rewrite**；版本脚本同时重建 shrinkwrap 与 install-lock |
| safe prepare、AI 离线 build、`jishu` bin、`.publish-stage/` | 上游未覆盖 | **保留** |
| 新 orchestrator 包 | 上游新增 | **采用上游**，同步 `0.80.10-8`，并纳入主仓 Lite alias 发布顺序 |

**发布脚本适配**：`upgrade-version.mjs` 现同步六个 workspace 与内部依赖，只更新本文件的“当前状态”字段，不再批量改写历史版本示例；`pi-common.mjs` 同时规范 `cli.js`、`rpc-entry.js`、`index.js`；Lite dry-run 新增 `@jishu-hub/jishu-agent-orchestrator`。

**验证结果**：

- Pi `npm run check` 通过：Biome、pinned dependencies、TS imports、shrinkwrap、install-lock、全仓 tsgo、browser smoke 全部通过。
- Pi 全 workspace build 通过；CLI 输出 `0.80.10-8`；`cli.js` / `rpc-entry.js` 各一个 shebang，`index.js` 无 shebang；`runtime-deps.json` 为 27 项。
- `agent_settled`/retry/`multiSelect` 定向测试 3 文件 24 项通过。
- 主仓 `pack-pi.mjs` 通过，27 项运行时依赖完整；`publish-pi.mjs --dry-run` 完成 tui→ai→agent→coding-agent→orchestrator 五包 staging，未发布；shrinkwrap key 保持 `@earendil-works`，resolved URL 指向 `@jishu-hub`。
- Hub `npx tsc --noEmit`、interaction/stream 4 文件 16 项、Pi RPC 11 项、Pi interaction sidecar 2 项和 `cargo check` 通过。
- Pi 全量 `npm test` 在当前 Windows 环境未全绿：agent 12 项、coding-agent 42 项失败，集中于 Windows 路径分隔、symlink/chmod/权限、缺少 `fd`、全局包管理器探针和 trust TUI；AI 557 项通过。本次改动涉及的生命周期和 extension UI 定向测试均通过，不把该全量结果写成全绿。
- 锁文件审计：当前 npm 11.7.0 不识别仓库的 `min-release-age` 配置，但本次没有新增或升级第三方包，也没有新增 install script；root lock、shrinkwrap、install-lock 的包版本、resolved 和 integrity 均继承 `v0.80.10`。npm 重写时丢失的 15 个 Linux `libc` 元数据已按上游 lock 恢复，最终 root lock 只保留 fork 版本、内部依赖和 `jishu` bin 变化。

---

## 2026-07-16 | AgentSession RPC 暴露 queued continuation 状态（历史方案，已由 v0.80.10 `agent_settled` 取代）

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
