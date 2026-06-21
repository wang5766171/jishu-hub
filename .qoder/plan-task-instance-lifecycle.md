# 任务功能三阶段生命周期实现计划

## Context

当前任务功能代码分散在 `chat-page.tsx`（~15个 useState + 散落回调）和 `task-workbench/index.tsx`（以 TaskGraph 为主实体）中，缺少统一的 TaskInstance 中心驱动。需求讨论→流程规划→任务执行三阶段没有完整串联，阶段导航、需求终稿卡片、执行阶段节点会话等核心交互缺失。

本次改造目标：**以 TaskInstance 为中心，chat-page 统一承载三阶段，复用现有会话/画布组件，聚焦整体流程跑通和数据结构完整正确。**

---

## 一、数据结构设计

### 1.1 核心类型定义

新文件: `src/features/task-instance/types.ts`

```typescript
// 三阶段生命周期
export type TaskPhase = "requirements" | "planning" | "execution";

// 后端 status 枚举
export type TaskInstanceStatus =
  | "requirements_discussing"
  | "requirements_finalized"
  | "planning_discussing"
  | "graph_created"
  | "running"
  | "completed";

// 阶段导航显示状态
export type PhaseDisplayState = "done" | "active" | "pending";

// 与后端 TaskLaunchInstance 1:1 映射
export interface TaskInstance {
  task_id: string;
  project_root: string;
  title: string;
  skill_id: string;
  status: TaskInstanceStatus;
  current_phase: TaskPhase;       // 后端 "graph" 映射为前端 "execution"
  requirement_file: string | null;
  requirement_session_id: string | null;
  planning_session_id: string | null;
  graph_id: string | null;
  created_at: number;
  updated_at: number;
}

// 执行阶段显示模式
export type ExecutionSurfaceView = "canvas" | "split" | "chat";

// 节点执行 session 信息（从 NodeAttempt 获取）
export interface NodeSessionInfo {
  node_id: string;
  node_run_id: string;
  attempt_number: number;
  session_id: string | null;
  status: string;
  agent_id: string | null;  // 不同节点可能不同 agent
}
```

### 1.2 状态映射规则

```
TaskInstance.status → 前端 TaskPhase:
  requirements_discussing, requirements_finalized → "requirements"
  planning_discussing                             → "planning"
  graph_created, running, completed               → "execution"

PhaseDisplayState 派生规则:
  requirements:
    current_phase === "requirements" → active
    current_phase ∈ {planning, execution} → done
  planning:
    current_phase === "planning" → active
    current_phase === "execution" → done
    current_phase === "requirements" → pending
    requirement_file 存在且非 active → done
  execution:
    current_phase === "execution" → active
    否则 → pending
```

### 1.3 useTaskInstance Hook 设计

新文件: `src/features/task-instance/use-task-instance.ts`

```
State:
  instances: TaskInstance[]
  activeInstanceId: string | null
  activePhase: TaskPhase
  readOnly: boolean                    // 回看已完成阶段时为 true
  executionView: ExecutionSurfaceView
  selectedNodeId: string | null
  nodeSessionMap: Record<string, NodeSessionInfo>

Derived (useMemo):
  activeInstance → 当前 TaskInstance
  phaseStates → Record<TaskPhase, PhaseDisplayState>
  activeSessionId → 当前阶段的 session_id
  canSend → 是否可发消息（active 阶段 + 非 readOnly）

Actions:
  loadInstances()                      → task_launch_list_sessions
  openTask(taskId)                     → 打开任务，自动定位到 current_phase
  openPhase(phase, readOnly?)          → 切换阶段视图
  markSession(sessionId, phase, title) → task_launch_mark_session
  finalizeRequirements(messages)       → task_requirement_finalize + 自动开启规划
  createAndAttachGraph(instruction)    → orchestrator_create_graph + task_launch_attach_graph
  renameTask(title)                    → task_launch_rename_task
  deleteTask(taskId)                   → task_launch_delete_task + 关联数据清理
  setExecutionView(view)               → 切换执行阶段显示模式
  selectNode(nodeId)                   → 选中节点 + 获取 NodeAttempt.session_id
```

### 1.4 与 useTaskGraph 的组合关系

```
useTaskInstance: 管理 TaskInstance 实体、阶段、session 关联
useTaskGraph:    管理图结构、版本、运行、节点运行、事件、审批

执行阶段组合:
  useTaskInstance 提供 graph_id → 传给 useTaskGraph.loadGraph()
  useTaskGraph 提供 graph/run/node 数据 → 传给 GraphEditor/InspectorPanel
  二者通过 graph_id 解耦，互不依赖
```

---

## 二、组件架构

### 2.1 chat-page 任务模式渲染结构

```
ChatPage (任务模式 workMode === "task")
├── Sidebar
│   ├── Regular Sessions (不变)
│   └── Task Instances (TaskInstance 条目)
│       └── TaskInstanceSidebarItem × N
│
└── Main Content
    ├── TaskPhaseNavBar (三阶段导航)
    └── PhaseContent (根据 activePhase 渲染)
        ├── [requirements] → PhaseRequirementsView
        ├── [planning]     → PhasePlanningView
        └── [execution]    → PhaseExecutionView
```

### 2.2 新组件清单

| 组件 | 文件 | 职责 |
|------|------|------|
| `TaskPhaseNavBar` | `task-instance/task-phase-nav-bar.tsx` | 三阶段导航条，done/active/pending |
| `PhaseRequirementsView` | `task-instance/phase-requirements-view.tsx` | 需求讨论：ChatInput + MessageView + 定稿卡片 |
| `PhasePlanningView` | `task-instance/phase-planning-view.tsx` | 流程规划：ChatInput + MessageView + 生成确认卡片 |
| `PhaseExecutionView` | `task-instance/phase-execution-view.tsx` | 任务执行：canvas/split/chat 三模式 + 节点 session |
| `RequirementFinalizeCard` | `task-instance/requirement-finalize-card.tsx` | 嵌入聊天的需求定稿确认卡 |
| `GraphGenerationCard` | `task-instance/graph-generation-card.tsx` | 嵌入聊天的流程图生成确认卡 |
| `ExecutionSessionTabs` | `task-instance/execution-session-tabs.tsx` | 执行阶段 session 标签页 |
| `TaskInstanceSidebarItem` | `task-instance/task-instance-sidebar-item.tsx` | 侧边栏任务条目 |

### 2.3 复用的现有组件

| 组件 | 来源 | 在哪复用 |
|------|------|----------|
| `ChatInput` | `components/sessions/chat-input.tsx` | 三阶段通用输入框 |
| `MessageView` | `components/sessions/message-view.tsx` | 三阶段消息渲染 |
| `StreamingMessage` | `components/sessions/streaming-message.tsx` | 实时流渲染 |
| `useSessionStream` | `hooks/use-stream-store.ts` | 流状态管理 |
| `GraphEditor` | `task-workbench/graph-editor.tsx` | 执行阶段画布 |
| `InspectorPanel` | `task-workbench/inspector-panel.tsx` | 节点详情检查器 |
| `RunInspector` | `task-workbench/run-inspector.tsx` | 运行事件/审批 |
| `useTaskGraph` | `task-workbench/use-task-graph.ts` | 图/运行管理 |
| `TaskContextBar` | `task-workbench/index.tsx` | 执行阶段状态栏 |
| `planning-session.ts` 工具 | `task-workbench/planning-session.ts` | buildPlanningInstruction 等 |

---

## 三、阶段转换流程

### 3.1 Requirements → Planning

```
1. Agent 在需求讨论中发起交互确认（"是否生成流程图"）
2. 用户确认 → 收集对话消息
3. invoke("task_requirement_finalize") → 写入 requirements.md
4. 更新 instance: status → planning_discussing, current_phase → planning
5. 自动发送规划首条消息（含 planning_instruction + skill 约束）
6. 监听 session_resolved → 更新 planning_session_id
7. invoke("task_launch_mark_session", { phase: "planning" })
8. UI 自动切换到 planning 视图
```

### 3.2 Planning → Execution

```
1. Agent 在规划中发起交互确认（"是否生成流程图"）
2. 用户确认 → 收集规划消息 → buildPlanningInstruction
3. invoke("orchestrator_create_graph") → [TaskGraph, GraphRevision]
4. invoke("task_launch_attach_graph") → 更新 instance.graph_id
5. 更新 instance: status → graph_created, current_phase → graph
6. UI 自动切换到 execution 视图
7. PhaseExecutionView 挂载 → useTaskGraph.loadGraph(graphId)
```

### 3.3 执行阶段节点 Session 追踪

```
1. useTaskGraph.startRun() → orchestrator_start_run
2. pollRunProjection() 轮询 → nodeRuns 更新
3. nodeRun.attempt_count > 0 时:
   invoke("orchestrator_get_attempt", { nodeRunId, attemptNumber })
   → NodeAttempt.session_id
4. 缓存到 nodeSessionMap[nodeId]
5. 点击节点 → ExecutionSessionTabs 展示该节点的 session
```

---

## 四、实施步骤

### Task A: 数据层与 Hook（2-3天）

| 步骤 | 文件 | 说明 |
|------|------|------|
| A1 | `src/features/task-instance/types.ts` | 创建所有类型定义 |
| A2 | `src/features/task-instance/use-task-instance.ts` | 实现 hook 核心逻辑 |

### Task B: 阶段导航与需求/规划视图（2-3天）

| 步骤 | 文件 | 说明 |
|------|------|------|
| B1 | `src/features/task-instance/task-phase-nav-bar.tsx` | 阶段导航条 |
| B2 | `src/features/task-instance/phase-requirements-view.tsx` | 需求阶段视图 |
| B3 | `src/features/task-instance/phase-planning-view.tsx` | 规划阶段视图 |
| B4 | `src/features/task-instance/requirement-finalize-card.tsx` | 需求定稿卡片 |
| B5 | `src/features/task-instance/graph-generation-card.tsx` | 生成确认卡片 |

### Task C: chat-page.tsx 集成（2-3天）

| 步骤 | 文件 | 说明 |
|------|------|------|
| C1 | `src/pages/chat-page.tsx` | 替换任务状态为 useTaskInstance 调用 |
| C2 | `src/pages/chat-page.tsx` | 替换任务渲染区域为 PhaseNavBar + PhaseContent |
| C3 | `src/features/task-instance/task-instance-sidebar-item.tsx` | 侧边栏条目组件 |
| C4 | `src/pages/chat-page.tsx` | 替换侧边栏任务渲染 |

### Task D: 执行阶段视图（3-4天）

| 步骤 | 文件 | 说明 |
|------|------|------|
| D1 | `src/features/task-instance/phase-execution-view.tsx` | 执行阶段主视图 |
| D2 | `src/features/task-instance/execution-session-tabs.tsx` | session 标签页 |
| D3 | 集成 GraphEditor + InspectorPanel + RunInspector | 复用现有组件 |
| D4 | 节点 session 追踪逻辑 | orchestrator_get_attempt 集成 |

### Task E: 清理与验证（1-2天）

| 步骤 | 文件 | 说明 |
|------|------|------|
| E1 | chat-page.tsx | 删除废弃的 taskLaunch* 状态和回调 |
| E2 | 端到端验证 | 三阶段完整流程 |
| E3 | i18n | zh/en 翻译补全 |

---

## 五、需要后端配合的变更

1. **`normalize_phase()` 添加 "execution" 支持**: `task_launch.rs` 当前只处理 "requirements" 和 "planning"
2. **运行完成联动 TaskInstance status**: 运行完成时自动更新 status → "completed"（可先前端轮询派生）
3. **批量获取节点 attempts**: 建议提供 `orchestrator_list_attempts_for_run(run_id)` 接口

---

## 六、关键文件路径

| 文件 | 角色 |
|------|------|
| `src-tauri/src/task_launch.rs` | 后端 TaskLaunchInstance |
| `src-tauri/src/orchestrator/domain/run.rs` | 后端 NodeAttempt (L236) |
| `src/pages/chat-page.tsx` | 主聊天页，任务模式入口 |
| `src/features/task-workbench/use-task-graph.ts` | 图/运行管理 hook |
| `src/features/task-workbench/graph-editor.tsx` | 图编辑器 |
| `src/features/task-workbench/inspector-panel.tsx` | 节点检查器 |
| `src/features/task-workbench/planning-session.ts` | 规划消息工具 |
| `src/hooks/use-stream-store.ts` | 流状态管理 |

---

## 七、验证计划

1. **新任务 → 需求讨论**: 侧边栏点"新任务"，进入需求讨论，发消息得到 Agent 回复
2. **需求确认 → 规划**: 确认需求终稿后自动进入规划阶段，规划会话可正常交互
3. **规划确认 → 执行**: 确认生成流程图后进入执行视图，画布展示节点
4. **执行运行**: 开始运行后节点状态实时更新，点击节点可查看执行 session
5. **阶段回溯**: 点击已完成阶段可查看历史会话（只读）
6. **侧边栏**: 任务实例列表正确显示，点击定位到正确阶段，重命名/删除正常
7. **编译验证**: 每步改动后 `npm run build` 确保编译通过
