# jishu-task-conductor 实施计划

> 基于 `jishu-task-conductor_详细设计.md`（已冻结最终版）制定。
>
> 六阶段递进，每阶段有明确的文件改动、验证标准和前置依赖。

---

## 总览

```
Phase 1 ── Conductor 骨架（Pi 扩展驱动 discuss→plan）
    │       证明阶段机 + 结构化工具 + select 关卡 + 白名单 + 恢复
    ▼
Phase 2 ── Hub 任务实例对接
    │       消除双状态，TaskInstance 权威，阶段同步
    ▼
Phase 3 ── 计划提案 → GraphRevision
    │       flow-plan-proposal.json 校验，转 GraphCommand，生成不可变版本
    ▼
Phase 4 ── 启动执行运行
    │       start_execution（模型调用）→ Hub 桥接 → GraphRun → 返回 run_id
    │       执行工作台切换，完成态投影器
    ▼
Phase 5 ── 监督和返工
    │       jishu agent supervisor，TaskEvent 投影，节点会话，steer 干预
    ▼
Phase 6 ── 多领域 + 安装集成
            domain 轴（research），随 jishu agent 安装，纯 Pi fallback
```

**原则**：每阶段独立可验证。Phase 1 不依赖 Hub（纯 Pi 扩展 + fallback 执行）。Phase 2-4 逐步接入 Hub。Phase 5-6 完善。

---

## Phase 1：Conductor 骨架

**目标**：Pi 扩展能稳定驱动 discuss→plan（不含 execute 的 Hub 对接），用 fallback 模式跑通完整三阶段。

### 任务

| # | 任务 | 文件 | 说明 |
|---|---|---|---|
| 1.1 | 创建 Conductor 扩展骨架 | `src-tauri/resources/extensions/jishu-task-conductor.ts` | default export factory function，照搬 plan-mode `index.ts` 结构。实现：registerCommand("jishu-task")、phase 状态机（idle/discuss/plan/execute/done）、ConductorState、appendEntry("jishu-conductor", state)、session_start 恢复 |
| 1.2 | 阶段白名单工具门 | 同上 | PHASE_ALLOWED_TOOLS（discuss/plan 只读+提交工具）；execute 在 external 模式交给 Hub；**fallback 模式单独定义 `FALLBACK_EXECUTE_ALLOWED_TOOLS`**（含受限写操作，危险操作需用户确认——评审 P1）；setActiveTools + on("tool_call") 兜底 |
| 1.3 | skill 注入 | 同上 | on("before_agent_start") 按 (domain, phase) 注入 METHODOLOGY；on("context") 过滤旧阶段注入 |
| 1.4 | 结构化工具注册 | 同上 | registerTool("lock_requirement")：接收需求文本，写 `.jishu-hub/tasks/<task_id>/artifacts/requirements/REQUIREMENTS.md`（Phase 1 就用命名空间，无 Hub 时生成临时 task_id——评审 P2）；registerTool("commit_plan")：接收节点数组，写 `.../artifacts/planning/flow-plan-proposal.json`，含 manifest |
| 1.5 | 人工关卡 | 同上 | on("agent_end") 检测 phase 收敛 → ctx.ui.select("确认进入下一阶段？") → sendMessage 驱动 |
| 1.6 | dev skill pack | `src-tauri/resources/skills/jishu-conductor-dev/{discuss,plan,execute}.SKILL.md` | 三阶段方法论：discuss 怎么提问、plan 怎么拆步+flow-plan-proposal.json 格式、execute 监督/fallback 怎么跑 |
| 1.7 | fallback 执行 | 扩展内 | 无 Hub 桥接时：注入步骤 + 哨兵 [STEP:n DONE]；on("turn_end") 扫哨兵跟踪进度 |
| 1.8 | 阶段标记消息 | 扩展内 | 每次切阶段发 customType=`jishu-conductor:phase-start:<phase>` 消息（供 Hub UI 分段） |
| 1.9 | 开发模式链接 | 脚本/手动 | `~/.jishu-agent/extensions/jishu-task-conductor.ts` → 源码；`~/.jishu-agent/skills/jishu-conductor-dev/` → 源码 |

### 验证

- `/jishu-task dev "实现登录功能"` 启动 → discuss 阶段
- discuss 白名单生效（edit/write 被拦截）
- agent 调 lock_requirement → 产物落盘 → select "确认进入规划？"
- 确认后 → plan 阶段 → commit_plan → select "批准并执行？"
- 确认后 → execute fallback（agent 按步跑 + 哨兵）
- 全部步骤完成 → phase=done
- 关闭重开 → session_start 恢复 phase

### 不做

- 不接 Hub orchestrator（Phase 4）
- 不做 TaskInstance 同步（Phase 2）
- 不做多领域（Phase 6）

---

## Phase 2：Hub 任务实例对接

**目标**：消除双状态——TaskInstance 是权威，Conductor 阶段变化同步 TaskInstance，任务列表读 TaskInstance。

**前置**：Phase 1 完成。

### 任务

| # | 任务 | 文件 | 说明 |
|---|---|---|---|
| 2.1 | Hub 新增桥接命令 | `src-tauri/src/lib.rs` + `src-tauri/src/task_launch.rs` | `conductor_sync_phase`：入参 {taskId, projectRoot, phase, domain, artifacts, expectedPhase, artifactHash}；**校验合法状态转换 + expectedPhase + artifact hash/manifest 完整性**（评审 P2）；通过后更新 TaskInstance。非法转换/校验失败 → 拒绝（保护事实权威） |
| 2.2 | Conductor 调桥接 | 扩展内 | lock_requirement / commit_plan 工具的 execute 内，通过 Hub RPC（Tauri command）调 conductor_sync_phase。Phase 1 用 fallback 时跳过 |
| 2.3 | 任务列表读 TaskInstance | `src/features/task-instance/` | 前端任务列表/工作台从 TaskInstance 读 phase/domain（不从 appendEntry 读） |
| 2.4 | 产物命名空间 | `src-tauri/src/task_launch.rs` | 产物落 `.jishu-hub/tasks/<task_id>/artifacts/{requirements,planning}/`，含 manifest.json |
| 2.5 | Hub 任务创建入口 | `src-tauri/src/lib.rs` | /jishu-task 启动时（或首次 sync_phase 时），如果 TaskInstance 不存在则创建 |
| 2.6 | resume 时 Hub 状态校正（评审 P1） | 扩展内 + `src-tauri/src/lib.rs` | conductor_load_task_state：session_start 时先从 Hub 拉取 TaskInstance（phase/status/run_status），覆盖 appendEntry。appendEntry 只补派侧 UI 状态。冲突时以 TaskInstance 为准 |

### 验证

- Conductor 阶段切换 → TaskInstance 同步更新
- 任务列表显示正确 phase
- appendEntry 只用于会话恢复（关闭重开）
- 多任务并行产物不冲突（命名空间隔离）
- TaskInstance 与 appendEntry 冲突时，以 TaskInstance 为准

---

## Phase 3：计划提案 → GraphRevision

**目标**：flow-plan-proposal.json 经 Hub 校验生成不可变 GraphRevision。

**前置**：Phase 2 完成。

### 任务

| # | 任务 | 文件 | 说明 |
|---|---|---|---|
| 3.1 | 提案校验命令 | `src-tauri/src/orchestrator/` | `orchestrator_validate_proposal`：入参 {proposalPath, projectRoot, taskId}；读 JSON → 校验 DAG/角色/依赖 → 转 GraphCommand[] |
| 3.2 | 生成 GraphRevision | 同上 | apply_commands 生成不可变 GraphRevision；返回 {graphId, revisionId} |
| 3.3 | commit_plan 调校验 | 扩展内 | commit_plan execute 内调 Hub 桥接 validate_proposal；返回 revisionId；**把 revisionId/content_hash 写入 planning/manifest.json 的 linked_revision_id**（评审 P1：start_execution 从 manifest 读取，不直接传 revisionId） |
| 3.4 | role 映射 | 校验逻辑内 | role → role_requirement.role_id；用户指定固定 agent → agent_assignment_constraint.locked_agent_id |
| 3.5 | manifest linked_revision | 产物落盘 | planning/manifest.json 的 linked_revision_id 填入 revisionId |

### 验证

- 提案校验通过 → GraphRevision 生成（graph_id + revision_id）
- 校验失败（DAG 环/缺角色）→ 错误反馈
- GraphRevision 不可变（再次提交生成新版本）
- 前端能读 GraphRevision 的 snapshot（节点/边）

---

## Phase 4：启动执行运行

**目标**：start_execution → Hub 启动 GraphRun → 返回 run_id → 执行工作台 → 完成态投影。

**前置**：Phase 3 完成。

### 任务

| # | 任务 | 文件 | 说明 |
|---|---|---|---|
| 4.1 | Conductor 注册 start_execution | 扩展内 | registerTool("start_execution")；入参含 taskId/projectRoot/conductorSessionId/flowPlanPath/goal/domain/expectedPhase/idempotencyKey；**从 manifest.json 读取 revisionId + content_hash 并校验**（不直接传 revisionId——评审 P1：commit_plan 写入 manifest，start_execution 读取，确保提案→版本→执行链完整） |
| 4.2 | Hub 启动执行命令 | `src-tauri/src/orchestrator/` | `orchestrator_start_run_from_revision`：基于 GraphRevision 启动 GraphRun；返回 run_id（不等完成） |
| 4.3 | Hub 桥接 | `src-tauri/src/lib.rs` | start_execution execute 内通过 Hub RPC 调 orchestrator_start_run_from_revision |
| 4.4 | 完成态投影器 | `src-tauri/src/orchestrator/` 或 `src-tauri/src/task_launch.rs` | 监听 RunStarted/RunCompleted/RunFailed/RunCancelled → 幂等更新 TaskInstance 的 active_run_id/last_run_id/run_status（**current_phase 保持 `execution`**，完成/失败/取消只改 run_status——评审 P1：对应 task_launch.rs 字段模型） |
| 4.5 | execute 界面切换 | `src/features/task-instance/` | Hub 检测 start_execution 调用 + GraphRun 启动 → 前端从会话视图切执行工作台（画布+节点会话+监督会话） |
| 4.6 | orchestrator 多 agent 调度 | 已有（orchestrator daemon） | GraphRun → NodeRun → NodeAttempt；按 role 分派 agent；复用现有引擎 |
| 4.7 | 幂等启动约束（评审 P1） | `src-tauri/src/task_launch.rs` + orchestrator | TaskInstance 新增 `last_launch_key` 字段；start_run 时校验 idempotencyKey：已有活跃 run 且 key 相同 → 返回现有 run_id（不重复启动）；key 不同 → 报错。fork/resume 时 key 继承或重生成 |

### 验证

- start_execution 返回 {status:"started", runId}
- GraphRun 启动（orchestrator daemon 持续调度）
- 执行工作台显示（画布节点状态实时更新）
- 多 agent 各自节点会话执行
- GraphRun 完成 → Hub 更新 `TaskInstance.run_status=completed + last_run_id`（current_phase 保持 execution——评审 P1）
- Conductor 会话展示完成（不承担判定）
- start_execution 不阻塞（工具立即返回）
- idempotencyKey 防重复启动

---

## Phase 5：监督和返工

**目标**：jishu agent supervisor，TaskEvent 投影，节点会话查看/干预，返工。

**前置**：Phase 4 完成。

### 任务

| # | 任务 | 文件 | 说明 |
|---|---|---|---|
| 5.1 | execute skill（监督方法论） | `src-tauri/resources/skills/jishu-conductor-dev/execute.SKILL.md` | 怎么看进度、何时建议返工、何时请求用户干预 |
| 5.2 | TaskEvent 投影 → 监督会话 | `src/features/task-instance/use-run-event-stream.ts` | 已有：轮询 task_event → 投影为消息流。execute 阶段 Conductor 主会话显示执行进度摘要 |
| 5.3 | 节点会话查看/干预 | `src/features/task-instance/phase-execution-view.tsx` | 已有：点节点 → NodeAttempt.session_id → 节点会话。steer 干预 |
| 5.4 | 分阶段查看（阶段标记分段） | `src/features/task-instance/` | 按 phase-start 标记切三段（discuss/plan/execute）；execute 段读执行工作台而非会话消息 |
| 5.5 | 返工 | 扩展 + Hub | 失败节点 → 用户决定返工 → **走 orchestrator 既有 revision/repair 协议**（不能直接修改已运行 revision——评审 P2）→ 形成新提案 → 新 GraphRevision → 基于 revision 差异重启受影响节点 |

### 验证

- 监督会话显示 TaskEvent 投影（节点开始/完成/失败/审批）
- 点节点进节点会话，可 steer
- 返工形成新提案，不静默改历史
- 分阶段查看正确（discuss/plan 段会话消息；execute 段执行工作台）

---

## Phase 6：多领域 + 安装集成

**目标**：domain 轴（research），随 jishu agent 安装，纯 Pi fallback。

**前置**：Phase 5 完成。

### 任务

| # | 任务 | 文件 | 说明 |
|---|---|---|---|
| 6.1 | research skill pack | `src-tauri/resources/skills/jishu-conductor-research/{discuss,plan,execute}.SKILL.md` | 调研方法论 |
| 6.2 | domain 切换 | 扩展内 | /jishu-task research "..." 启动；METHODOLOGY 加 research |
| 6.3 | 扩展安装 | `src-tauri/src/task_plan.rs` + `src-tauri/src/lib.rs` | install_builtin_skill 旁边新增扩展文件复制到 ~/.jishu-agent/extensions/；skill pack 复制到 ~/.jishu-agent/skills/ |
| 6.4 | 纯 Pi fallback 验证 | — | 无 Hub 环境（纯 Pi 命令行）：fallback 模式跑通三阶段 |
| 6.5 | Pi Package 打包 | `package.json` | @jishu/jishu-task-conductor；pi manifest |

### 验证

- dev/research 切换（不同方法论）
- 随 jishu agent 安装（扩展 + skill 自动落位）
- 纯 Pi 环境 fallback（无 Hub，agent 按步跑）

---

## 技术风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Pi 扩展开发不熟悉 | Phase 1 阻塞 | 照搬 plan-mode `index.ts`（已完整读源码）；先跑最小骨架 |
| Hub 桥接（Tauri command） | Phase 2-4 阻塞 | 首选 Tauri command（已有 pi_rpc_runtime 桥接基础）；fallback pi.exec shell |
| orchestrator 接入复杂 | Phase 3-4 | 复用现有引擎（create_graph/apply_commands/start_run 已有）；proposal→GraphCommand 转换是新增逻辑 |
| 完成态投影器幂等 | Phase 4 | RunStarted/RunCompleted 事件已有；投影器是新增 listener（幂等 upsert TaskInstance） |
| extension_ui select 通道 | Phase 1 | 已验证（pi_rpc_runtime.rs:889-923 select 映射）；confirm 不映射已规避 |

---

## 验收标准（对应设计文档评审）

1. 前端不再通过关键词判断阶段完成
2. 阶段推进不再依赖 advance_phase.mjs
3. 需求和计划提交是结构化工具调用（lock_requirement / commit_plan）
4. 任务列表状态来自 TaskInstance，不来自解析会话文本
5. 派会话恢复依赖 appendEntry，但 Hub 事实不依赖 appendEntry
6. 计划提案必须经 Hub 校验后才能成为 GraphRevision
7. 执行运行启动后，start_execution 不长时间阻塞等待完成
8. orchestrator 在主会话关闭后仍能继续执行
9. 执行进度来自 TaskEvent 投影
10. 节点执行会话可独立查看
11. 人工确认使用 ctx.ui.select（已验证通道）
12. 工具门是阶段白名单
13. 多任务并行时产物不会互相覆盖（命名空间）
14. fork/resume 时，TaskInstance 和 appendEntry 有明确冲突解决规则（TaskInstance 为准）
