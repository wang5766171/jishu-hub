# jishu-task-conductor 详细设计

> 基于 Pi（pi-coding-agent）原生扩展机制，实现「需求讨论 → 流程规划 → 流程执行」三阶段确定性工作流。
>
> 主旨：**主流程由 Pi 扩展（Conductor）驱动阶段转换；产出物内容与执行方式由 skill + 外部执行器决定。**

| 项 | 值 |
|---|---|
| 状态 | Draft（待评审） |
| 日期 | 2026-06-24 |
| 适用 Pi 版本 | `packages/coding-agent` 当前 main（fork 内 `third_party/pi`） |
| 参考范式 | `examples/extensions/plan-mode/`（官方两阶段范例，本方案是它的三阶段泛化） |
| 关联文档 | `workflow-conductor-design.md`（原始方案）、Hub 现有 orchestrator/TaskGraph 设计 |

---

## 0. 术语速查

| 术语 | 含义 |
|---|---|
| **Conductor** | 本扩展（`jishu-task-conductor`），跑在 Pi 里的 TypeScript 代码，管阶段推进的"机制" |
| **skill pack** | 每个 domain 一套的 markdown 方法论文件，告诉 agent 每阶段"怎么做"，被 Conductor 注入 |
| **执行器** | execute 阶段的执行实现，Conductor 注册 `start_execution` 工具（模型调用），内部通过 Hub 桥接启动 orchestrator |
| **domain** | 领域（dev=开发 / research=调研），决定用哪套 skill pack |
| **phase** | 当前阶段（idle/discuss/plan/execute/done） |
| **产物** | 阶段产出文件（REQUIREMENTS.md / flow-plan.md / flow-plan-proposal.json），落盘，跨阶段契约 |
| **哨兵** | agent 回复里约定的标记文本（如 `[STEP:1 DONE]`），Conductor 扫描它跟踪进度 |

---

## 1. 设计定位（松耦合）

Conductor 只管**派主会话内的阶段纪律**，**不是任务事实权威**（评审 5.1 修正）：

| 职责 | 做什么 | 不做什么 |
|---|---|---|
| 阶段纪律 | discuss→plan→execute 阶段机驱动、人工关卡、工具门、方法注入、会话内恢复 | 不管任务事实（TaskInstance/GraphRun/NodeRun 由 Hub 数据库权威管理） |
| 产物提交入口 | 提供 `lock_requirement` / `commit_plan` 等结构化提交工具 | 不管产物校验/转图（Hub 负责） |
| 产物串联 | 下一阶段启动时读上一阶段产物 | 不管产物怎么转图/节点 |

> **权威边界（评审核心修正）**：派扩展管"阶段怎么走"；中枢任务系统管"事实是什么"。TaskInstance 状态、GraphRevision、GraphRun、TaskEvent 由 Hub 作为最终权威。Conductor 的 `appendEntry` 只用于派侧会话恢复，**不作为任务列表/工作台/执行态的权威来源**。

**松耦合边界**（评审 5.2 修正）：
- Conductor 不知道 Hub、不知道 orchestrator/TaskGraph、不知道画布。
- execute 阶段：Conductor 注册 `start_execution` 工具，注入指令让**模型调用**它（Pi 扩展不能直接调别的扩展工具）。工具内部通过 Hub 桥接启动 orchestrator，返回 run_id（不等完成）。
- Hub 环境有桥接 → orchestrator 多 agent 调度 + 画布；纯 Pi 无桥接 → Conductor 内置兜底（agent 按步跑）。

**分层类比**：Conductor 是引擎（不变）、skill pack 是燃料（按领域换）、`start_execution` 工具是传动轴（标准接口，模型调用 → 桥接 Hub）、Hub orchestrator 是轮子（按环境换）。

---

## 2. 命名与分工（最终确认）

| 角色 | 名称 | 性质 | 职责 |
|---|---|---|---|
| 扩展（阶段机） | `jishu-task-conductor` | 代码（Pi extension） | 驱动 discuss→plan→execute、工具门、注入 skill、断点恢复。注册 `start_execution`/`lock_requirement`/`commit_plan` 工具（模型调用） |
| skill pack（方法论） | `jishu-conductor-dev` / `jishu-conductor-research` | 文本（markdown） | 每领域每阶段"怎么提问/怎么拆步/产出什么格式"。Conductor 按当前阶段注入给 agent |
| 执行入口 | `start_execution` 工具 | 代码（Conductor 注册） | execute 阶段启动执行。模型调用此工具 → 工具内部 Hub 桥接启动 orchestrator → 返回 run_id（不等完成）。纯 Pi 环境无桥接 → Conductor fallback |

**派生命名**：
- npm package：`@jishu/jishu-task-conductor`（含扩展代码 + 内置兜底执行器 + 默认 dev skill pack）
- 产物文件：`REQUIREMENTS.md`（discuss）、`flow-plan.md` + `flow-plan-proposal.json`（plan）
- appendEntry customType：`jishu-conductor`（阶段状态写会话 JSONL）
- 会话注入消息 customType：`jishu-conductor:phase:<domain>:<phase>`

---

## 3. 架构总览

```
用户启动: /jishu-task dev "实现一个登录功能"
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│  jishu-task-conductor 扩展（领域无关的状态机）               │
│                                                             │
│  state = { domain, phase, artifactPaths, steps[] }          │
│                                                             │
│  before_agent_start ── 按 (domain,phase) 注入 skill ──▶ LLM │
│  tool_call ────────── 工具门（阶段白名单，评审 5.8）        │
│  turn_end ─────────── 扫哨兵（仅 fallback），更新 steps     │
│  agent_end ────────── 人工关卡（ctx.ui.select）             │
│                       确认后 sendMessage 驱动下一阶段        │
│  session_start ────── 读 appendEntry 恢复 state             │
│  context ──────────── 过滤非当前阶段的注入消息              │
│                                                             │
│  execute 阶段: 模型调 start_execution（Conductor 注册）     │
│    ├─ Hub 环境 → 桥接启动 orchestrator（返回 run_id）       │
│    └─ 纯 Pi 环境 → 内置兜底（agent 按步骤跑 + 哨兵跟踪）    │
└─────────────────────────────────────────────────────────────┘
  │
  ▼  产物链（全部落盘文件，松耦合契约）
discuss ──[REQUIREMENTS.md]──▶ plan ──[flow-plan.md + flow-plan-proposal.json]──▶ execute
```

---

## 3.5 会话模型与分阶段查看

### 单会话连续

discuss→plan→execute 跑在**同一个 Pi 会话**里（照搬 plan-mode 范式）：

1. **Pi 的阶段机依赖单会话**：`appendEntry`（状态持久化）、`context` 事件（过滤旧阶段注入）、`session_start`（恢复）都基于单会话。拆成多会话则这套机制全废。
2. **避免多会话隔离问题**：之前 Hub 层多会话方案（requirement_session + planning_session 分开）导致了"会话串、隔离失败"。单会话只有一条消息流，天然不存在串的问题。
3. **上下文连贯**：plan 阶段能看到 discuss 的讨论（context 过滤只丢旧阶段的"指令注入"，不丢正常对话），execute 能看到 plan 的方案。

### 分阶段查看（阶段标记 + UI 分段）

单会话不代表混成一团。靠**阶段标记 + UI 分段**实现分阶段查看：

**Conductor 侧**——每次切阶段，往会话写阶段分隔标记：

```ts
pi.sendMessage({
  customType: `jishu-conductor:phase-start:${phase}`,
  display: true,
  content: `── 进入${phaseName}阶段 ──`,
});
```

加上 `appendEntry("jishu-conductor", state)` 里记录的 phase 变化点。

**Hub GUI 侧**——读会话消息流时，按 `phase-start` 标记切成三段：
- discuss 段：从 `phase-start:discuss` 到 `phase-start:plan` 之前
- plan 段：从 `phase-start:plan` 到 `phase-start:execute` 之前
- execute 段：`phase-start:execute` 之后

**UI 呈现方式**（可选）：
- 方式 A：会话流里插"阶段分隔卡片"（视觉分界线），消息连续但可见边界
- 方式 B：顶部阶段 Tab（需求讨论 / 流程规划 / 执行），点 Tab 筛选只看该段
- 方式 C：两者结合——默认连续流 + 分隔卡片，点卡片折叠/筛选

> execute 阶段注意：external 模式下，会话里 execute 段很简短（只有驱动指令 + 完成摘要），实际执行内容在 orchestrator 的各节点会话里。execute 的"查看"主要靠执行工作台（画布 + 节点会话），不是会话消息。详见 §5.3。

---

## 4. 状态机设计

### 4.1 状态结构

```ts
type Phase = "idle" | "discuss" | "plan" | "execute" | "done";
type Domain = "dev" | "research"; // 可扩展

interface Step {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "done" | "skipped";
}

interface ConductorState {
  domain: Domain;
  phase: Phase;
  /** 原始诉求 */
  goal: string;
  /** 进入流程前的工具集，退出时还原 */
  toolsBeforeWorkflow?: string[];
  /** plan 阶段产出的步骤（discuss/execute 由执行器管，这里仅兜底执行器用） */
  steps: Step[];
  /** 各阶段产物路径 */
  artifacts: {
    requirements?: string;   // REQUIREMENTS.md
    flowPlanMd?: string;     // flow-plan.md（人看）
    flowPlanJson?: string;   // flow-plan-proposal.json（机器读）
  };
  /** 执行器模式：external（Hub 注册）/ fallback（内置兜底）/ null（未到 execute） */
  executorMode?: "external" | "fallback" | null;
}
```

### 4.2 阶段转换图

```
idle ──[/jishu-task 启动]──▶ discuss
discuss ──[需求锁定 + 人工确认]──▶ plan
plan ──[流程就绪 + 人工确认]──▶ execute
execute ──[全部完成]──▶ done
```

每个转换在 `agent_end` 事件里判定 + `ctx.ui.select` 人工关卡（评审 5.4：confirm 不映射）。

### 4.3 持久化与恢复（照搬 plan-mode 模式）

- **写**：每次 state 变化调 `pi.appendEntry("jishu-conductor", state)`。写入会话 JSONL，**不发 LLM**。
- **读**：`on("session_start")` 从 `ctx.sessionManager.getEntries()` 取最后一条 `customType === "jishu-conductor"` 恢复。
- **重算**：resume 后恢复阶段状态（来自 appendEntry）。**fallback 模式**额外扫描"最近一次阶段进入标记"之后的 assistant 消息，重放哨兵重建 `steps[].status`；**external 模式**执行进度来自 Hub 的 TaskInstance/GraphRun/TaskEvent，不从会话重放。

> 这样 `/resume`、`/fork`、`/tree` 跳转都能接续流程。

---

## 5. 三阶段详细规范

每个阶段定义：**目标 / 工具集 / 注入 skill / 产出物 / 转移条件**。

### 5.1 discuss（需求讨论）

| 项 | 内容 |
|---|---|
| 目标 | 澄清需求、锁定范围；产出需求文件 |
| 工具集 | 阶段白名单：`read, grep, find, ls, questionnaire, lock_requirement`（评审 5.8） |
| 注入 skill | `METHODOLOGY[domain].discuss`（如何提问、澄清哪些维度） |
| 产出物 | `REQUIREMENTS.md`（落 `.jishu-hub/tasks/<task_id>/artifacts/requirements/`，评审 5.7） |
| 转移条件 | agent 调 `lock_requirement` 工具提交需求（结构化，评审 5.5）；`agent_end` 检测到工具调用后 `ctx.ui.select` 弹"确认进入规划？" |

### 5.2 plan（流程规划）

| 项 | 内容 |
|---|---|
| 目标 | 基于需求文件，产出结构化流程 |
| 工具集 | 阶段白名单：`read, grep, find, ls, commit_plan`（评审 5.8） |
| 注入 skill | `METHODOLOGY[domain].plan`（dev：拆代码任务；research：拆调研任务） |
| 产出物 | `flow-plan.md`（人看的说明）+ `flow-plan-proposal.json`（机器读的**计划提案**，评审 5.6；落 `.jishu-hub/tasks/<task_id>/artifacts/planning/`） |
| 转移条件 | agent 调 `commit_plan` 工具提交结构化节点提案；`agent_end` 弹"批准并执行？" |

### 5.3 execute（流程执行）

execute 是三阶段中最复杂的——不再是单 agent 对话，而是**多 agent 协作 + jishu agent 监督**。

#### 核心定位

| 项 | 内容 |
|---|---|
| 目标 | 以 `flow-plan-proposal.json` 为输入，经 Hub 校验生成 GraphRevision 后**按 GraphRevision 执行**——**多种 agent 各负责不同节点，jishu agent 只监督** |
| 界面 | **切换到执行工作台**（画布 + 节点会话 + 监督会话），不再是纯会话视图 |
| 执行主体 | **Hub orchestrator daemon**（持续调度，按 role 分派节点给不同 agent） |
| jishu agent 角色 | **supervisor（监督者）**——不执行节点，只看进度 + 可被用户用来 steer 干预 |
| Conductor 角色 | **轻量**：注册 `start_execution` 工具 + 注入监督 skill。启动后不等完成（评审 5.2/5.3） |

#### execute 完整链路（external 模式 = Hub 环境）

```
plan 结束，commit_plan 工具提交了流程计划提案（flow-plan-proposal.json）
  │
  ▼ 1. 用户确认执行后，Conductor 注入指令让模型调用 start_execution 工具
  │     （Conductor 自己注册此工具——评审 5.2：Pi 扩展不能直接调别的扩展工具）
  │
  ▼ 2. start_execution 工具 execute 内部（通过 Hub 桥接）：
  │     a. 读 flow-plan-proposal.json（计划提案）
  │     b. 转成 GraphCommand（node → add_node，depends_on → add_edge，role → agent_assignment）
  │     c. Hub 校验提案 → 生成不可变 GraphRevision
  │     d. 基于 GraphRevision 启动 GraphRun
  │     e. 立即返回 { status:"started", runId } ——不等全部完成（评审 5.3）
  │
  ▼ 3. Hub 后端持续进程（execute 的核心，execute 期间一直运行）：
  │     - orchestrator daemon：持续调度节点（GraphRun → NodeRun → NodeAttempt）
  │     - 按 role 分派 agent：developer 节点→claude_code，tester 节点→codex，各自独立节点会话
  │     - 主会话监控：jishu agent（supervisor）通过 task_event 投影实时看进度
  │     - 实时推送：节点状态变化 → GUI 画布更新
  │
  ▼ 4. Conductor 主会话进入"执行监督中"（phase=execute，不等工具返回完成）：
  │     - Conductor 注入 execute skill（监督方法论：怎么看进度、何时干预）
  │     - jishu agent 不亲自执行任何节点
  │     - 用户可通过 jishu agent steer 干预，或直接进节点会话干预
  │
  ▼ 5. GraphRun 全部完成 → **Hub 推进 TaskInstance 到 done**（Hub 是完成态权威）
  │        → Conductor 会话展示完成（不承担完成态判定）
```

#### 各角色职责

| 角色 | execute 阶段干什么 | 持续/一次性 |
|---|---|---|
| **Conductor**（Pi 扩展） | 注册 `start_execution` 工具（模型调用）；注入监督 skill；启动后不等完成 | 一次性（启动后交棒） |
| **start_execution 工具**（Conductor 注册） | 通过 Hub 桥接：读提案 → 转 GraphCommand → 校验 GraphRevision → 启动 GraphRun → 返回 run_id | 一次性（启动执行） |
| **orchestrator daemon**（Hub 后端） | 按 role 调度节点，分派 agent，跟踪 NodeRun/NodeAttempt，推进依赖，审批/重试/预算 | **持续**（execute 期间一直跑） |
| **各种 agent**（developer/tester/...） | 在各自的节点会话里执行被分派的节点 | 各节点独立 |
| **jishu agent**（主会话） | supervisor：监督进度、接收用户 steer、不执行节点 | 持续监控 |
| **Hub 画布/GUI** | 显示 TaskGraph 节点状态（颜色/进度），点节点进节点会话 | 持续更新 |

> **关键区分**：Conductor（Pi 扩展）在 execute 是一次性的：触发 start_execution 后立即返回 run_id，**不等待完成**。Hub orchestrator daemon 是持续的（execute 期间一直调度）。**完成态由 Hub 根据 GraphRun/TaskEvent 推进 TaskInstance**，Conductor 不承担完成态判定。

#### 关键：flow-plan-proposal.json 的 role 字段驱动分派

plan 阶段 agent 产出 flow-plan-proposal.json 时，每个节点带 `role`（developer/tester/architect/...）。Hub 执行器转 GraphCommand 时的映射口径：`role` → `role_requirement.role_id`（orchestrator 按 role 调度）；只有用户显式指定固定 agent 时才写 `agent_assignment_constraint.locked_agent_id`。不同节点可以用不同 agent（如 developer 节点用 claude_code，tester 节点用 codex）。

#### execute 界面呈现（执行工作台）

discuss/plan 阶段是纯会话视图。execute 阶段**切换到执行工作台**（Hub 架构设计文档 §4 的三维模型）：

| 区域 | 内容 |
|---|---|
| **画布** | TaskGraph 可视化，节点方块 + 依赖线 + 实时状态色（running/done/failed） |
| **节点会话** | 点某个节点，看该节点被分派的 agent 的执行会话（NodeAttempt.session_id），可 steer 干预 |
| **监督会话/主任务会话** | jishu agent 的监控视图（task_event 投影，显示整体执行进度、节点完成事件、审批请求） |

**切换时机**：Conductor 进入 execute 阶段（`start_execution` 被调、orchestrator 启动 GraphRun 后），Hub GUI 从会话视图切换到执行工作台。

#### fallback 模式（无 Hub 环境的退化场景）

纯 Pi 环境（无 Hub 桥接）时，Conductor 内置兜底：
- 注入步骤列表 + 哨兵协议（`[STEP:n DONE]`）
- jishu agent 自己按步执行（退化场景，单 agent，无多 agent 协作）
- `turn_end` 扫哨兵跟踪进度
- **不适用于 Hub 环境**——Hub 环境必须走 external 模式（orchestrator 多 agent 调度）

#### 转移条件

- external 模式：**Hub 是完成态权威**——GraphRun/TaskEvent 推进 TaskInstance 到 done；Conductor 只在会话打开时展示/同步，不承担完成态判定
- fallback 模式：所有步骤 `[STEP:n DONE]` → phase=done

---

## 6. 产物契约（确切格式）

### 6.1 REQUIREMENTS.md（discuss 产出）

Markdown，由 discuss skill 约束格式。最低要求含：目标、范围、范围外、约束、验收标准。Conductor 不解析内容，只记录路径。

### 6.2 flow-plan-proposal.json（plan 产出，**计划提案**——评审 5.6/5.7）

> **评审修正（5.6）**：这是**计划提案**（不是最终任务图），需 Hub 校验后生成不可变 GraphRevision。执行绑定 GraphRevision，不是绑定原始计划文件。
>
> **评审修正（5.7）**：产物落 `.jishu-hub/tasks/<task_id>/artifacts/planning/`（任务命名空间），不落工作目录根。

```jsonc
{
  "schema": "jishu-flow-plan-proposal/v1",
  "domain": "dev",
  "goal": "实现一个登录功能",
  "requirements_ref": "artifact://requirements/REQUIREMENTS.md",
  "nodes": [
    {
      "id": "node_1",
      "title": "数据库 schema",
      "responsibility": "设计 users 表 + 迁移脚本",
      "depends_on": [],
      "acceptance": "迁移可执行，表结构符合需求",
      "role": "developer"
    },
    {
      "id": "node_2",
      "title": "登录接口",
      "responsibility": "实现 /api/login，密码哈希校验",
      "depends_on": ["node_1"],
      "acceptance": "正确凭证返回 token，错误凭证 401",
      "role": "developer"
    }
  ],
  "generated_at": 1782231268234
}
```

字段说明：
- `id`：节点唯一标识（agent 产出，执行器消费）
- `title` / `responsibility`：节点职责（自然语言）
- `depends_on`：前置依赖（引用其他节点 id）
- `acceptance`：验收口径
- `role`：建议执行角色（对应 orchestrator 的 role_requirement）
- **不含**：坐标 x/y、颜色、布局——这些由执行器/前端负责

### 6.3 flow-plan.md（plan 产出，人看）

Markdown，agent 产出的流程说明（给用户审阅）。格式由 plan skill 约束。Conductor 不解析。

### 6.4 artifact manifest 最小 schema（落地前补齐）

每个产物目录含 `manifest.json`，避免实现时各写各的：

```jsonc
{
  "artifact_id": "requirements",           // 产物标识（requirements / planning）
  "schema_version": "jishu-flow-plan-proposal/v1",
  "content_hash": "sha256:...",            // 内容哈希（校验完整性）
  "generated_phase": "discuss",            // 生成阶段（discuss / plan）
  "generated_session_id": "019ef...",      // 生成会话 id
  "task_id": "task_xxx",                   // 关联任务实例
  "skill_pack": "jishu-conductor-dev",     // 用的方法包
  "skill_pack_hash": "sha256:...",         // 方法包哈希
  "linked_revision_id": null               // 关联 GraphRevision（plan 产物校验后填）
}
```

---

## 7. skill pack 规范

### 7.1 目录布局

每个 domain 一个 skill pack 目录，含三阶段方法论：

```
~/.jishu-agent/skills/
  jishu-conductor-dev/
    discuss.SKILL.md      ← 需求讨论方法论（怎么提问、澄清哪些维度）
    plan.SKILL.md         ← 流程规划方法论（怎么拆步、flow-plan-proposal.json 格式约束）
    execute.SKILL.md      ← 执行方法论（改码规范/测试/报告格式）
  jishu-conductor-research/
    discuss.SKILL.md
    plan.SKILL.md
    execute.SKILL.md
```

> 这些文件同时是普通 Pi skill（可 `/skill:` 手动调用），也是 Conductor 启动时读入 `METHODOLOGY` 的来源。

### 7.2 METHODOLOGY 注册表

Conductor 启动时把 skill 文件读进内存（一次 `fs.readFile`，缓存）：

```ts
const METHODOLOGY: Record<Domain, Record<"discuss" | "plan" | "execute", string>> = {
  dev:      { discuss: devDiscuss,    plan: devPlan,    execute: devExecute },
  research: { discuss: researchDiscuss, plan: researchPlan, execute: researchExecute },
};
```

skill pack 路径解析：从 `~/.jishu-agent/skills/jishu-conductor-<domain>/<phase>.SKILL.md` 读取。启动时扫描已安装的 domain。

### 7.3 注入机制

`before_agent_start` 每个 turn 都注入当前阶段的方法论：

```ts
pi.on("before_agent_start", async () => {
  if (state.phase === "idle" || state.phase === "done") return;
  const skill = METHODOLOGY[state.domain][state.phase];
  return {
    message: {
      customType: `jishu-conductor:phase:${state.domain}:${state.phase}`,
      display: false,
      content: `[JISHU-TASK:${state.domain}:${state.phase}]\n${skill}\n${phaseDiscipline(state.phase)}`,
    },
  };
});
```

`customType` 带 domain+phase 标签，供 `context` 事件过滤过期阶段注入（见 9.1）。

---

## 8. start_execution 工具契约

**这是 Conductor 和外部执行器之间的唯一接口**。

### 8.1 工具定义（Conductor 注册，模型调用——评审 5.2）

> **评审修正（5.2）**：Pi 扩展不能直接调别的扩展工具（types.ts 无 callTool API）。改为 Conductor **自己注册** `start_execution` 工具，在 execute 阶段注入指令让**模型调用**它。

- **Hub 环境**（external）：`start_execution` 内部通过 Hub 桥接启动 orchestrator，返回 run_id（不等完成）。
- **纯 Pi 环境**（fallback）：Conductor 改为注入步骤 + 哨兵协议，让 agent 按步跑。

### 8.2 工具入参（Conductor 传给执行器）

```ts
{
  taskId: string,              // 任务实例 id（落地前补齐：显式任务身份）
  projectRoot: string,         // 项目根路径
  conductorSessionId: string,   // Conductor 所在 Pi 会话 id（追溯/投影用）
  flowPlanPath: string,        // flow-plan-proposal.json 文件路径
  requirementsPath?: string,   // REQUIREMENTS.md 路径（可选）
  goal: string,                // 原始诉求
  domain: Domain,              // 领域
  expectedPhase: string,       // 期望阶段（"execute"，防误调）
  idempotencyKey: string,      // 幂等键（防 fork/resume 重复启动 run）
}
```

### 8.3 工具出参（启动型，评审 5.3 修正）

> **评审修正（5.3）**：执行器**不阻塞等待全部完成**。启动 GraphRun 后立即返回 run_id。后续完成状态从 TaskEvent / GraphRun 读取，不通过工具返回。

```ts
{
  status: "started" | "failed",
  taskId: string,             // 任务实例 id
  graphId: string,            // 任务图 id
  revisionId: string,         // 任务图版本 id（不可变快照）
  runId?: string,             // 执行运行 id（启动成功时）
  summary?: string,           // 启动摘要
  error?: string,             // 失败原因（status=failed 时）
}
```

后续完成状态由 Hub orchestrator daemon 持续调度，进度通过 TaskEvent 投影显示。Conductor 不等工具返回完成（避免长时间阻塞 Pi 工具调用）。

### 8.4 start_execution 工具实现（Conductor 注册，Hub 桥接——评审 5.2/5.3）

> Conductor 注册此工具，模型调用。工具内部通过 Hub 桥接启动执行，**立即返回 run_id**（不等全部完成）。

```ts
pi.registerTool({
  name: "start_execution",
  label: "Start Execution",
  description: "启动任务流程执行（Hub orchestrator）",
  parameters: Type.Object({
    taskId: Type.String(),              // 任务实例 id
    projectRoot: Type.String(),         // 项目根路径
    conductorSessionId: Type.String(),  // Conductor 所在 Pi 会话 id
    flowPlanPath: Type.String(),        // flow-plan-proposal.json 路径
    requirementsPath: Type.Optional(Type.String()),
    goal: Type.String(),
    domain: Type.String(),
    expectedPhase: Type.String(),       // 期望阶段（防误调）
    idempotencyKey: Type.String(),      // 幂等键（防重复启动 run）
  }),
  async execute(_id, params, _signal, _onUpdate, _ctx) {
    // 通过 Hub 桥接（Hub RPC / Tauri command 优先，pi.exec shell 调 jishu-cli 作为 fallback）：
    //   a. 读 flow-plan-proposal.json
    //   b. 转 GraphCommand
    //   c. Hub 校验 → 生成 GraphRevision
    //   d. 启动 GraphRun
    //   e. 立即返回 run_id（不等全部完成——评审 5.3）
    const result = await bridgeToHub("start_run", params);
    return {
      content: [{ type: "text", text: `执行已启动，runId=${result.runId}` }],
      details: { status: "started", runId: result.runId, revisionId: result.revisionId },
    };
  },
});
```

> 工具返回 `started + runId` 后，Conductor 进入"执行监督中"（phase=execute）。后续完成由 Hub GraphRun/TaskEvent 驱动，不通过工具返回。

### 8.5 Conductor 兜底实现（fallback 模式）

纯 Pi 环境（无 Hub 桥接）时，Conductor 在 execute 阶段注入步骤列表 + 哨兵协议：

```
[EXECUTING PLAN]
按以下步骤执行，每完成一步在回复末尾输出 [STEP:<id> DONE]：
1. [node_1] 数据库 schema
2. [node_2] 登录接口（依赖 node_1）
...
```

`turn_end` 扫 `[STEP:<id> DONE]`，更新 `steps[].status`。全部 done → phase=done。

---

## 9. 上下文管理

### 9.1 过期阶段上下文过滤（照搬 plan-mode）

阶段切换后，旧阶段的注入消息不应再干扰模型。`on("context")` 过滤：

```ts
pi.on("context", async (event) => {
  if (state.phase === "idle") return;
  const currentTag = `jishu-conductor:phase:`;
  return {
    messages: event.messages.filter((m) => {
      const msg = m as AgentMessage & { customType?: string };
      // 只保留当前阶段的注入，丢弃其它阶段的
      if (msg.customType?.startsWith(currentTag) && !msg.customType.includes(`:${state.phase}`)) {
        return false;
      }
      return true;
    }),
  };
});
```

### 9.2 抗 compaction：产出物落盘

compaction 有损（发给模型的上下文会被摘要压缩）。因此：
- 所有结构化产出写文件（REQUIREMENTS.md / flow-plan-proposal.json）。
- execute 阶段让 agent 读文件而非依赖会话记忆。
- state 在 `appendEntry` 里，压缩不影响。

### 9.3 工具门（阶段白名单——评审 5.8）

> **评审修正（5.8）**：禁用 edit/write 不够（bash 也能写文件）。改为**阶段白名单**，未知工具默认不可用。

```ts
const PHASE_ALLOWED_TOOLS: Record<Phase, string[]> = {
  discuss: ["read", "grep", "find", "ls", "questionnaire", "lock_requirement"],
  plan: ["read", "grep", "find", "ls", "commit_plan"],
  execute: [], // execute 阶段工具由 Hub orchestrator 按节点角色/权限决定
};

function setPhaseTools(phase: Phase) {
  const allowed = PHASE_ALLOWED_TOOLS[phase];
  if (allowed) pi.setActiveTools(allowed); // 白名单：未列入的工具不可见
}

// 兜底：即使白名单遗漏，也拦截已知危险工具
pi.on("tool_call", async (event) => {
  if ((state.phase === "discuss" || state.phase === "plan")
      && ["edit", "write", "bash"].includes(event.toolName)) {
    return { block: true, reason: `${state.phase} 阶段白名单不允许 ${event.toolName}` };
  }
});
```

---

## 10. 人工关卡（ctx.ui 通道）

Conductor 的 `agent_end` 人工关卡用 `ctx.ui.select`（**不用 confirm**）。

> **评审修正（5.4）**：Hub 的 `convert_extension_ui_request`（`pi_rpc_runtime.rs:885-947`）只映射 `select` 和 `input`，**`confirm` 走 `_ => None` 不映射**（L943-945 注释 "fire-and-forget or not mapped"）。用 `ctx.ui.confirm` 会卡住等不到响应。统一用 `ctx.ui.select` 表达确认。

```
Conductor 调 ctx.ui.select("请选择下一步", ["批准进入下一阶段", "返回修改"])
  → Pi RPC 发 extension_ui_request (method=select)
  → Hub pi_rpc_runtime.rs:889-923 convert_extension_ui_request → InteractionRequest（select 已映射）
  → Hub 前端渲染弹窗（现有交互问答 UI）
  → 用户选择 → extension_ui_response 回 Pi
  → ctx.ui.select 的 Promise resolve
```

证据：
- `types.ts:306`：`hasUI: boolean`（true in TUI and RPC modes）
- `rpc-mode.ts:136-139`：`select` 通过 `extension_ui_request` 发送
- `pi_rpc_runtime.rs:889-923`：`select` 映射为 InteractionRequest（已验证）
- `pi_rpc_runtime.rs:943-945`：**`confirm` 不映射**（`_ => None`），必须用 select

**Hub 侧零改动**——复用现有 select 交互机制。

---

## 11. Hub 对接

### 11.1 Hub 注册执行器

Conductor 注册 `start_execution` 工具（§8），模型调用后工具内部通过 Hub 桥接：读提案 → 转 GraphCommand → 校验 GraphRevision → 启动 GraphRun → 返回 run_id（不等完成）。桥接首选：Hub RPC / Tauri command（评审 5.10）；pi.exec shell 作为 fallback。

### 11.2 execute 界面切换（会话视图 → 执行工作台）

discuss/plan 阶段，Hub GUI 显示纯会话视图（Pi 会话消息流）。

execute 阶段，Hub GUI **切换到执行工作台**（三维模型）：
- **画布**：TaskGraph 可视化，节点状态实时更新
- **节点会话**：点节点查看该 agent 的执行会话
- **监督会话**：jishu agent 监控视图（task_event 投影）

**切换时机**：Hub 检测到 Conductor 进入 execute 阶段（`start_execution` 工具被调用 + orchestrator GraphRun 启动），GUI 从会话视图切换到执行工作台。

### 11.3 Hub 持续进程（orchestrator daemon + 主会话监控）

execute 阶段，Hub 后端有两个持续运行的进程：

**orchestrator daemon**（调度引擎）：
- execute 期间持续运行
- 按 role 调度节点（GraphRun → NodeRun → NodeAttempt），分派给不同 agent
- 跟踪状态（succeeded/failed/retry），推进依赖，处理审批/重试/预算
- 直到全部节点完成
- **完成态投影器**（落地前补齐）：orchestrator daemon 在 `RunStarted/RunCompleted/RunFailed/RunCancelled` 时调用 TaskInstance 状态投影，幂等更新 `active_run_id / last_run_id / run_status`

**主会话监控**（jishu agent = supervisor）：
- jishu agent（主会话）通过 task_event 投影实时看各节点执行进度
- 不亲自执行节点（supervisor 角色）
- 用户可通过 jishu agent steer 干预，或直接进节点会话干预
- Hub 的 useRunEventStream 持续轮询 task_event，投影为监督会话消息流

> **关键**：Conductor（Pi 扩展）在 execute 是一次性的（启动后返回 run_id，**不等待全部完成**）。真正的持续调度在 Hub orchestrator daemon。Pi 扩展启动完就交棒给 Hub。**完成态由 Hub 推进**（GraphRun/TaskEvent → TaskInstance），Conductor 不承担完成态判定。

### 11.4 GUI 感知阶段/进度

Hub GUI 需要知道当前 phase 和进度：
- **人工关卡**：通过 `extension_ui_request`（已对接），Hub 弹窗时知道阶段转换点
- **阶段标记消息**：Conductor 切阶段时发 `phase-start` 消息（customType=`jishu-conductor:phase-start:...`），Hub 从 agent-event 流读到，解析得当前 phase
- **execute 进度**：external 模式下 Hub orchestrator 自己跟踪（NodeRun/NodeAttempt），推到画布 + 监督会话

### 11.5 任务列表

Hub 的任务列表（侧边栏）仍保留。**阶段状态读 TaskInstance（Hub 数据库权威），不读 appendEntry**（评审 5.1）。Conductor 阶段变化时通过 Hub 桥接同步更新 TaskInstance。`appendEntry` 只用于派主会话恢复。

---

## 12. 安装集成（随 jishu agent 安装）

### 12.1 复用现有安装机制

jishu-hub 已有 skill 安装机制（`task_plan.rs`）：
- `install_builtin_skill(skill_id)`：复制 skill 文件
- `link_to_pi_skills_dir`：在 `~/.jishu-agent/skills/` 创建链接
- `copy_bundled_extra_files`：复制 scripts/references
- `lib.rs:886/917`：安装 jishu agent 时自动 `install_builtin_skill("jishu-task-planner")`

**扩展安装新增**：
1. Conductor 扩展文件复制到 `~/.jishu-agent/extensions/jishu-task-conductor.ts`（Pi 从 `agentDir/extensions/` 加载扩展）。
2. skill pack 复制到 `~/.jishu-agent/skills/jishu-conductor-dev/`（复用 `link_to_pi_skills_dir`）。
3. `lib.rs` 安装 jishu agent 时，除了 `install_builtin_skill`，新增扩展文件复制。

### 12.2 文件布局（安装后）

```
~/.jishu-agent/
  extensions/
    jishu-task-conductor.ts      ← Conductor 扩展（阶段机 + 兜底执行器）
  skills/
    jishu-conductor-dev/         ← dev 领域 skill pack
      discuss.SKILL.md
      plan.SKILL.md
      execute.SKILL.md
    jishu-conductor-research/    ← research 领域 skill pack（后续）
      ...
```

### 12.3 开发模式

开发时扩展源码放 `src-tauri/resources/extensions/jishu-task-conductor.ts`，skill 放 `src-tauri/resources/skills/jishu-conductor-dev/`。安装时复制到 `~/.jishu-agent/`。开发环境可通过 Pi 的项目级扩展（`.pi/extensions/`）或符号链接指向源码。

---

## 13. Pi API 映射表（已核对源码）

| 需求 | Pi API | 源码位置 |
|---|---|---|
| 阶段机状态 | 扩展闭包 + `pi.appendEntry("jishu-conductor", state)` | `types.ts:1238` |
| 恢复状态 | `on("session_start")` + `ctx.sessionManager.getEntries()` | plan-mode `index.ts:340` |
| 切工具集 | `pi.setActiveTools(names)` / `pi.getActiveTools()` | `types.ts:1257/1263` |
| 兜底拦截工具 | `on("tool_call")` 返回 `{block, reason}` | `types.ts:1168` |
| 每阶段注入 skill | `on("before_agent_start")` 返回 `{message}` | `types.ts:1155` |
| 过滤过期上下文 | `on("context")` 返回 `{messages}` | `types.ts:1149` |
| 哨兵扫描 | `on("turn_end")` 读 `event.message` 文本 | `types.ts:1159` |
| 人工关卡 | `ctx.ui.select`（RPC 模式走 extension_ui_request） | `rpc-mode.ts:136` + `pi_rpc_runtime.rs:889` |
| 驱动下一阶段 | `pi.sendMessage(msg, {triggerTurn, deliverAs})` | `types.ts:1223` |
| 注册转移工具 | `pi.registerTool(ToolDefinition)` | `types.ts:1178` |
| 注册启动命令 | `pi.registerCommand` | `types.ts:1187` |
| 进度 UI | `ctx.ui.setStatus` / `ctx.ui.setWidget` | plan-mode `index.ts:63/80` |

---

## 14. 启动命令

```ts
pi.registerCommand("jishu-task", {
  description: "启动任务工作流：/jishu-task <dev|research> <需求>",
  handler: async (args, ctx) => {
    const [domain, ...rest] = args.trim().split(/\s+/);
    if (!METHODOLOGY[domain as Domain]) {
      ctx.ui.notify(`未知领域：${domain}。支持：dev, research`, "warning");
      return;
    }
    state.domain = domain as Domain;
    state.goal = rest.join(" ");
    state.toolsBeforeWorkflow = pi.getActiveTools();
    setPhase("discuss", ctx);
    pi.sendUserMessage(
      `[启动任务工作流:${domain}] 目标：${state.goal}\n先澄清需求，收敛后调用 lock_requirement 工具提交需求。`,
    );
  },
});
```

---

## 15. 边界情况

| 场景 | 处理 |
|---|---|
| 用户中途 abort | Escape 取消当前 run；state 不前进，下次 agent_end 重新判定。已落盘产出保留 |
| fork / resume | appendEntry 恢复阶段状态；fallback 重放哨兵重建 steps；external 执行进度来自 Hub TaskInstance/GraphRun/TaskEvent。各分支独立 state |
| execute 启动失败（external） | `start_execution` 返回 `status=failed`（提案校验/GraphRevision/GraphRun 启动阶段）；Conductor 通知用户，不进 execute |
| execute 运行失败（external） | 节点失败由 `TaskEvent/GraphRun` 投影（不是工具返回）；Hub 更新 `TaskInstance.run_status=failed`；用户可查看失败节点/返工 |
| execute 出错（fallback） | 工具失败由 agent-core 转 isError 回灌模型，模型自纠；某步卡住可人工跳过 |
| 模型切换 | 流程不依赖具体模型，继续跑 |
| 单会话多领域 | 不支持。一个会话一个 domain。换领域建议 fork 新分支 |
| compaction | 产出物在文件里，execute 读文件；state 在 appendEntry，压缩不影响 |
| Hub 未注册执行器 | Conductor 用 fallback 模式（agent 按步跑 + 哨兵），仍能跑通 |

---

## 16. 实施路线图

1. **流程指挥器骨架**：fork plan-mode，discuss+plan 单 domain（dev），结构化工具（lock_requirement / commit_plan），select 人工关卡，白名单工具门，appendEntry 恢复。
2. **中枢任务实例对接**：消除双状态——TaskInstance 权威，Conductor 阶段变化同步 TaskInstance，任务列表读 TaskInstance 不读 appendEntry。
3. **计划提案→任务图版本**：flow-plan-proposal.json 校验，转 GraphCommand，Hub 生成不可变 GraphRevision。
4. **启动执行运行**：Conductor 注册 start_execution 工具（模型调用），Hub 桥接启动 GraphRun 返回 run_id（不等完成），前端切执行工作台。
5. **监督和返工**：jishu agent supervisor，TaskEvent 投影，节点会话独立查看，返工形成新提案。
6. **多领域 + 安装集成**：domain 轴 + skill pack，随 jishu agent 安装扩展 + skill。

---

## 17. 与现有 Hub 任务功能的关系

| 现有 Hub 组件 | 新方案下的去留 |
|---|---|
| TaskInstance（SQLite）+ advance_phase.mjs | **废弃**阶段推进职责；TaskInstance 保留做任务列表索引（**阶段状态读 TaskInstance 权威，不读 appendEntry**——评审 5.1） |
| 前端阶段切换（TaskPhaseContainer） | **简化**：不再驱动阶段，只渲染（读 TaskInstance） |
| orchestrator + TaskGraph | **保留**：作为 Hub 执行器的执行引擎（external 模式） |
| 画布（GraphEditor） | **保留**：Hub 执行器建 TaskGraph 后，画布可视化 |
| extension_ui_request 对接 | **保留**：人工关卡通道（已有） |
| jishu-task-planner skill（旧） | **替换**：被 jishu-conductor-{domain} skill pack 取代 |

---

## 18. 评审修订记录（2026-06-24）

> 基于 `jishu-task-conductor_评审意见.md` 的逐条辩证。关键问题已源码核实。

### 完全采纳（9 条）

| 评审条目 | 修正内容 | 已改章节 | 源码核实 |
|---|---|---|---|
| **5.1 Conductor 不是任务事实权威** | Conductor 管会话阶段纪律；Hub 的 TaskInstance/GraphRun/TaskEvent 是权威。appendEntry 只用于派侧恢复，不作任务列表来源 | §1, §11.5 | — |
| **5.2 扩展不能直接调工具** | Conductor 自己注册 `start_execution` 工具（模型调用），不直接调 Hub 工具。工具内部通过 Hub 桥接启动 orchestrator | §5.3, §8 | types.ts 无 callTool API（已核实） |
| **5.3 执行器不阻塞** | 启动 GraphRun 后立即返回 run_id，不等全部完成。后续进度从 TaskEvent 读 | §8.3 | — |
| **5.4 confirm 不映射** | 统一用 `ctx.ui.select`，不用 `confirm` | §10 | pi_rpc_runtime.rs:943 `_ => None`（已核实） |
| **5.5 哨兵改结构化工具** | 需求锁定用 `lock_requirement`，计划提交用 `commit_plan`。哨兵仅 fallback 模式 | §5.1, §5.2 | — |
| **5.6 flow-plan-proposal.json 是提案** | flow-plan-proposal.json 是计划提案（`jishu-flow-plan-proposal/v1`），Hub 校验后生成不可变 GraphRevision。执行绑定 GraphRevision | §6.2 | — |
| **5.7 产物落任务命名空间** | 产物落 `.jishu-hub/tasks/<task_id>/artifacts/`，含 manifest（hash/阶段/会话/版本），不落工作目录根 | §6 | — |
| **5.8 工具门改白名单** | 阶段白名单（discuss/plan 只允许只读 + 结构化提交工具），未知工具默认不可用，不仅禁 edit/write | §9.3 | — |
| **5.9 单会话取舍明确** | discuss+plan+execute 监督同一主会话（逻辑分段查看），节点执行独立会话。文档明确此取舍 | §3.5 | — |

### 采纳但需后续设计（1 条）

| 评审条目 | 说明 |
|---|---|
| **5.10 执行器注册关系** | 采纳：不依赖同名工具加载顺序。Conductor 注册 `start_execution` 工具（统一入口）。**桥接首选已定**：Hub RPC / Tauri command 优先（错误模型/权限/路径/超时/幂等可控），`pi.exec` shell 调 jishu-cli 作为 fallback。 |

### 有疑问（0 条）

本次评审意见全部合理，无异议。5.2（扩展间工具调用）和 5.4（confirm 映射）已逐字核实 Pi 源码确认。

### 落地路线调整（采纳评审 §8）

实施路线从原"P0~P5"调整为评审建议的五阶段：
1. **流程指挥器骨架**：discuss+plan，结构化工具（lock_requirement / commit_plan），select 人工关卡，白名单工具门
2. **中枢任务实例对接**：消除双状态，TaskInstance 权威，阶段变化同步 TaskInstance
3. **计划提案→任务图版本**：flow-plan-proposal.json 校验，转 GraphCommand，生成不可变 GraphRevision
4. **启动执行运行**：基于 GraphRevision 启动 GraphRun，返回 run_id，不阻塞
5. **监督和返工**：jishu agent supervisor，TaskEvent 投影，节点会话独立查看

---

## 附录：参考的官方文件

- `examples/extensions/plan-mode/index.ts` — 阶段机/工具切换/注入/跟踪/恢复的最完整范例
- `examples/extensions/plan-mode/utils.ts` — 哨兵解析/步骤提取
- `src/modes/rpc/rpc-mode.ts:135` — RPC 模式 ExtensionUIContext 实现（ctx.ui 通道）
- `src/core/extensions/types.ts` — ExtensionAPI / ToolDefinition / 各事件 result 类型（API 权威来源）
- Hub `src-tauri/src/pi_rpc_runtime.rs:515` — extension_ui_request 对接
- Hub `src-tauri/src/task_plan.rs` — skill 安装机制（扩展安装复用）
