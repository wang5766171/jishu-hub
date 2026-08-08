/**
 * jishu-task-conductor — Pi 扩展，驱动 discuss→plan→execute 三阶段工作流。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type Phase = "idle" | "discuss" | "plan" | "execute" | "done";
type Domain = "dev" | "research";
type SkillPhase = "discuss" | "plan" | "execute";

interface Step {
  id: string;
  title: string;
  responsibility: string;
  acceptance: string;
  depends_on: string[];
  role: string;
  status: "pending" | "done" | "skipped";
}

interface RequirementCandidate {
  kind: "requirements";
  id: string;
  revision: number;
  title: string;
  goal: string;
  scope: string;
  out_scope?: string;
  constraints?: string;
  acceptance: string;
  assumptions?: string;
  markdown: string;
}

interface PlanNode {
  id: string;
  title: string;
  responsibility: string;
  depends_on: string[];
  acceptance?: string;
  role?: string;
}

interface PlanCandidate {
  kind: "plan";
  id: string;
  revision: number;
  generatedAt: number;
  nodes: PlanNode[];
  markdown: string;
}

type Candidate = RequirementCandidate | PlanCandidate;

interface PendingConfirmation {
  id: string;
  kind: "requirements-to-plan" | "plan-to-execute";
  candidateId: string;
}

interface ConductorState {
  schemaVersion: 3;
  domain: Domain;
  phase: Phase;
  goal: string;
  artifacts: {
    taskId?: string;
    requirements?: string;
    flowPlanMd?: string;
    flowPlanJson?: string;
  };
  candidate?: Candidate;
  pendingConfirmation?: PendingConfirmation;
  revisionInstruction?: string;
  /** 铁律7：待在下一次 turn_end 落地的目标 phase（轮内确认后不立即 setPhase）。 */
  enteringPhase?: Phase;
  /** R3：turn_end 落地某阶段后标记待驱动，空闲 agent_end 消费并启下一阶段轮次+持久化分隔符。 */
  pendingDrive?: Phase;
  /** R6：修订分支登记待驱动的修订轮（用户补充原话），由空闲 agent_end 单一驱动，避免流式 followUp 双驱动。 */
  pendingRevise?: { kind: "requirements" | "plan"; answer: string };
  steps: Step[];
  executorMode?: "external" | "fallback" | null;
}

const DOMAINS: Domain[] = ["dev"];
const PLAN_ROLES = new Set([
  "developer",
  "tester",
  "architect",
  "reviewer",
  "researcher",
]);

const PHASE_ALLOWED_TOOLS: Partial<Record<Phase, string[]>> = {
  discuss: [
    "read",
    "grep",
    "find",
    "ls",
    "lock_requirement",
    "request_user_input",
  ],
  plan: ["read", "grep", "find", "ls", "commit_plan", "request_user_input"],
  execute: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

/** 根据 phase + executorMode 返回当前允许的工具列表。 */
function allowedToolsFor(phase: Phase, executorMode?: string): string[] | undefined {
  // #5 纵深防御：external 模式 execute 阶段 Conductor 不执行，收窄为只读（硬保障靠 commit_plan 的 terminate）
  if (phase === "execute" && executorMode === "external") {
    return ["read", "grep", "find", "ls"];
  }
  return PHASE_ALLOWED_TOOLS[phase];
}

const SKILLS_DIR =
  process.env.JISHU_CONDUCTOR_SKILLS_DIR ||
  join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".jishu-agent",
    "skills",
  );

function loadSkill(domain: Domain, phase: SkillPhase): string {
  try {
    return readFileSync(
      join(SKILLS_DIR, `jishu-conductor-${domain}`, `${phase}.SKILL.md`),
      "utf-8",
    );
  } catch {
    return `[jishu-task-conductor] Missing skill: jishu-conductor-${domain}/${phase}.SKILL.md. Install skill pack first.`;
  }
}

function phaseDisplayName(phase: Phase): string {
  const names: Record<Phase, string> = {
    idle: "空闲",
    discuss: "需求讨论",
    plan: "流程规划",
    execute: "流程执行",
    done: "已完成",
  };
  return names[phase] ?? phase;
}

function phaseDiscipline(phase: Phase): string {
  const rules: Record<Phase, string> = {
    idle: "",
    discuss: [
      "⚠️⚠️⚠️【CRITICAL DISCIPLINE REDLINE - 需求讨论阶段】⚠️⚠️⚠️",
      "1. 你的唯一目标是逐步澄清并收敛需求；每轮只问一个核心问题。",
      "2. 🚫 绝对禁止提供具体技术实现、代码结构或代码片段。",
      "3. 需求明确后调用 lock_requirement 提交候选需求；最终转场由 Conductor 问答卡片确认。",
      "4. 你在此阶段没有 edit/write/bash 工具。",
    ].join("\n"),
    plan: [
      "⚠️⚠️⚠️【CRITICAL DISCIPLINE REDLINE - 流程规划阶段】⚠️⚠️⚠️",
      "1. 你的唯一目标是基于已确认的 REQUIREMENTS.md 设计任务节点方案。",
      "2. 如有真实缺口，每轮只澄清一个问题；方案明确后调用 commit_plan 提交候选。",
      "3. 🚫 绝对禁止开始实现或输出业务代码。最终转场由 Conductor 问答卡片确认。",
    ].join("\n"),
    execute: [
      "⚠️⚠️⚠️【CRITICAL DISCIPLINE REDLINE - 流程执行阶段】⚠️⚠️⚠️",
      "1. 只能执行用户已确认并正式落盘的计划。",
      "2. 按节点依赖和顺序执行，满足每个节点的验收标准。",
      "3. 用户点击停止或要求暂停时立即停止。",
      "4. 如果已生成执行图，等待用户在 Hub 执行工作台手动启动 run。",
    ].join("\n"),
    done: "",
  };
  return rules[phase] ?? "";
}

function splitList(value: string): string[] {
  return value
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderRequirement(params: {
  title: string;
  goal: string;
  scope: string;
  out_scope?: string;
  constraints?: string;
  acceptance: string;
  assumptions?: string;
}): string {
  const lines = [
    `# ${params.title}`,
    "",
    "## 目标",
    params.goal,
    "",
    "## 范围",
    ...splitList(params.scope).map((item, index) => `${index + 1}. ${item}`),
    "",
  ];
  if (params.out_scope) {
    lines.push(
      "## 范围外",
      ...splitList(params.out_scope).map((item) => `- ${item}`),
      "",
    );
  }
  if (params.constraints) {
    lines.push(
      "## 约束条件",
      ...splitList(params.constraints).map((item) => `- ${item}`),
      "",
    );
  }
  lines.push(
    "## 验收标准",
    ...splitList(params.acceptance).map(
      (item, index) => `${index + 1}. ${item}`,
    ),
    "",
  );
  if (params.assumptions) {
    lines.push(
      "## 关键假设",
      ...splitList(params.assumptions).map((item) => `- ${item}`),
      "",
    );
  }
  return lines.join("\n");
}

function renderPlan(nodes: PlanNode[]): string {
  return [
    "## 流程方案",
    "",
    `共 ${nodes.length} 个节点：`,
    "",
    ...nodes.map((node, index) => {
      const dependency =
        node.depends_on.length > 0
          ? `（依赖：${node.depends_on.join(", ")}）`
          : "（无依赖）";
      const role = node.role ? ` [${node.role}]` : "";
      const acceptance = node.acceptance
        ? `\n   - 验收：${node.acceptance}`
        : "";
      return `${index + 1}. **${node.title}**${role}${dependency}\n   - 职责：${node.responsibility}${acceptance}`;
    }),
    "",
    "---",
    "",
    "以上为候选计划，等待用户确认后进入执行。",
  ].join("\n");
}

function validatePlan(nodes: PlanNode[]): void {
  if (nodes.length === 0) throw new Error("计划至少需要一个节点");
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node.id.trim() || !node.title.trim() || !node.responsibility.trim()) {
      throw new Error("每个节点都必须包含 id、title 和 responsibility");
    }
    if (ids.has(node.id)) throw new Error(`节点 id 重复：${node.id}`);
    if (node.role && !PLAN_ROLES.has(node.role))
      throw new Error(`不支持的节点角色：${node.role}`);
    ids.add(node.id);
  }
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      if (dependency === node.id)
        throw new Error(`节点不能依赖自身：${node.id}`);
      if (!ids.has(dependency))
        throw new Error(`节点 ${node.id} 引用了不存在的依赖：${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`计划依赖存在环：${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

export default function conductorExtension(pi: ExtensionAPI): void {
  const state: ConductorState = {
    schemaVersion: 3,
    domain: "dev",
    phase: "idle",
    goal: "",
    artifacts: {},
    steps: [],
  };
  let toolsBeforeWorkflow: string[] | undefined;
  let terminalStopReason: string | undefined;

  const persist = (): void => {
    pi.appendEntry("jishu-conductor", { ...state, toolsBeforeWorkflow });
  };

  function artifactsDir(): string {
    const taskId = state.artifacts.taskId || "draft";
    return join(process.cwd(), ".jishu-hub", "tasks", taskId, "artifacts");
  }

  /**
   * 任务隔离锚点：把「当前 task_id + 本任务产物绝对路径」显式注入模型上下文。
   *
   * 背景（2026-08-02 手测缺陷）：同一 project_root 下发起第二个任务时，进入规划阶段的
   * 驱动指令只说「读取需求终稿」而不给路径，模型便用 ls/find 在 `.jishu-hub/tasks/`
   * 下自行搜索，扫到**上一个任务**的 REQUIREMENTS.md，导致第二个任务按第一个任务的
   * 需求出规划。这里给出唯一权威路径并禁止跨任务目录检索。
   */
  function taskAnchor(): string {
    const taskId = state.artifacts.taskId || "draft";
    const lines = [
      "【任务隔离锚点 — 强制遵守】",
      `- 当前任务 ID：${taskId}`,
      `- 本任务目录：${join(process.cwd(), ".jishu-hub", "tasks", taskId)}`,
    ];
    if (state.artifacts.requirements) {
      lines.push(`- 需求终稿（唯一权威来源）：${state.artifacts.requirements}`);
    }
    if (state.artifacts.flowPlanMd) {
      lines.push(`- 流程方案：${state.artifacts.flowPlanMd}`);
    }
    lines.push(
      "- 🚫 严禁读取或引用 `.jishu-hub/tasks/` 下**其它任务目录**的任何文件（其它 task_* 的 REQUIREMENTS.md / flow-plan.md 等）。同一项目可能并存多个历史任务，读错即污染本任务。",
      "- 🚫 严禁用 ls/find/grep 在 `.jishu-hub/tasks/` 下搜索需求或计划文件。只能读上面给出的确切路径；该路径不存在时直接说明，不得寻找替代文件。",
      "- ✅ 本任务需求以「本会话内已确认的对话内容 + 上述需求终稿路径」为准，二者之外的任何任务产物都与本任务无关。",
    );
    return lines.join("\n");
  }

  function writeArtifact(
    subdir: string,
    filename: string,
    content: string,
  ): string {
    const dir = join(artifactsDir(), subdir);
    mkdirSync(dir, { recursive: true });
    const fullPath = join(dir, filename);
    writeFileSync(fullPath, content, "utf-8");
    return fullPath;
  }

  /**
   * 任务隔离硬闸门：判断某个路径是否越界到别的任务目录。
   *
   * 返回 null 放行，否则返回阻断原因。taskAnchor() 是软约束（提示词），
   * 本函数是硬约束——模型无视提示词去 ls/find `.jishu-hub/tasks/` 时直接 block。
   */
  function taskIsolationViolation(rawPath: string | undefined): string | null {
    if (typeof rawPath !== "string" || !rawPath.trim()) return null;
    const taskId = state.artifacts.taskId || "draft";
    const normalized = (isAbsolute(rawPath) ? rawPath : join(process.cwd(), rawPath))
      .replace(/\\/g, "/")
      .toLowerCase();
    const marker = "/.jishu-hub/tasks";
    const at = normalized.indexOf(marker);
    if (at === -1) return null;
    const rest = normalized.slice(at + marker.length).replace(/^\/+/, "");
    if (!rest) {
      return `禁止列举/搜索 .jishu-hub/tasks 根目录：那里并存多个历史任务，极易读到别的任务的需求或计划。当前任务是 ${taskId}，只能访问它自己的目录。`;
    }
    if (rest.split("/")[0] === taskId.toLowerCase()) return null;
    return `禁止访问其它任务的目录（当前任务是 ${taskId}）。跨任务读取会让需求/计划串台，请只使用任务隔离锚点里给出的路径。`;
  }

  /** bash 命令文本里的任务目录越界检测（read/ls/find/grep 之外的旁路）。 */
  function bashTaskIsolationViolation(command: string): string | null {
    const lowered = command.replace(/\\/g, "/").toLowerCase();
    if (!lowered.includes(".jishu-hub/tasks")) return null;
    const taskId = (state.artifacts.taskId || "draft").toLowerCase();
    // 用 exec 循环而非 matchAll：扩展由 pi 直接 transpile，不假设 lib/downlevelIteration。
    const re = /\.jishu-hub\/tasks(\/[^\s"';|&)]*)?/g;
    let match: RegExpExecArray | null = re.exec(lowered);
    while (match !== null) {
      const segment = (match[1] ?? "").replace(/^\/+/, "").split("/")[0];
      if (segment !== taskId) {
        return `禁止在命令中访问 .jishu-hub/tasks 下的其它任务目录（当前任务是 ${state.artifacts.taskId || "draft"}）。`;
      }
      match = re.exec(lowered);
    }
    return null;
  }

  // ── Hub 桥接（Phase 2）：通过 select 通道编码调用 Hub 后端命令 ──
  // Pi 扩展 API 无通用 invoke，复用 ctx.ui.select 通道：
  // title 以 "\x00hub_invoke:" 开头，Hub 拦截后直接执行并响应，不经过前端。
  // 返回 { success, data?, error? } 或 null（桥接不可用 / 超时，如纯 Pi 环境）。
  // timeoutMs：超时保护（默认 5s），防止阻塞事件管线导致死锁。
  async function hubInvoke(
    ctx: ExtensionContext,
    command: string,
    params: Record<string, unknown>,
    timeoutMs = 5000,
  ): Promise<{ success: boolean; data?: unknown; error?: string } | null> {
    try {
      const payload = JSON.stringify({ command, params });
      const selectPromise = ctx.ui.select(`\x00hub_invoke:${payload}`, [
        "\x00ok",
      ]);
      // 超时保护：避免 Hub 无响应时阻塞事件管线（turn_end 里尤其关键）
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs),
      );
      const result = await Promise.race([selectPromise, timeoutPromise]);
      if (!result) return null;
      return JSON.parse(result) as {
        success: boolean;
        data?: unknown;
        error?: string;
      };
    } catch {
      // 桥接不可用（纯 Pi 环境 / Hub 未启动）→ fallback 模式
      return null;
    }
  }

  async function syncHubPhase(
    ctx: ExtensionContext,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await hubInvoke(ctx, "conductor_sync_phase", params);
    // No bridge means standalone Pi fallback. Hub command results are nested in
    // the transport response, and a command-level rejection is authoritative.
    if (!result) return true;
    if (!result.success) {
      ctx.ui.notify(result.error ?? "Hub 阶段同步调用失败", "error");
      return false;
    }
    const data = result.data as
      { success?: boolean; error?: string } | undefined;
    if (data?.success !== false) return true;
    ctx.ui.notify(data.error ?? "Hub 拒绝了任务阶段同步", "error");
    return false;
  }

  const phaseTag = (): string =>
    `jishu-conductor:phase:${state.domain}:${state.phase}`;

  function setPhase(phase: Phase, ctx: ExtensionContext): void {
    state.phase = phase;
    const allowed = allowedToolsFor(phase, state.executorMode);
    if (allowed) pi.setActiveTools(allowed);
    else if (toolsBeforeWorkflow) pi.setActiveTools(toolsBeforeWorkflow);
    ctx.ui.setStatus("jishu-conductor-phase", phase);
    persist();
  }

  function queueRevision(kind: "requirements" | "plan", answer: string): void {
    // R6：只登记待修订，不在流式态发 followUp（避免与未终止轮双驱动）。
    // 工具修订分支返回 terminate:true 当前轮干净停，由空闲 agent_end 消费 pendingRevise 单一驱动修订轮。
    state.pendingConfirmation = undefined;
    state.revisionInstruction = answer;
    state.pendingRevise = { kind, answer };
    persist();
  }

  /** R6：由 agent_end 在空闲态驱动修订轮（携基线 + 用户补充原话）。
   *  注意：followUp/continue 驱动的轮 **不触发 before_agent_start**（已核实 pi 源码：emitBeforeAgentStart 仅在
   *  AgentSession.prompt() 路径，agent.continue() 绕开）。故基线+补充**必须**放进 followUp 正文本身，
   *  不能依赖 before_agent_start 的 REVISION CONTEXT（那一轮它不注入）。 */
  function driveRevision(kind: "requirements" | "plan", answer: string): void {
    const baseline = state.candidate?.kind === kind ? state.candidate.markdown : "";
    const label = kind === "requirements" ? "需求" : "计划";
    const tool = kind === "requirements" ? "lock_requirement" : "commit_plan";
    pi.sendMessage(
      {
        customType: `jishu-conductor:revise:${kind}`,
        display: false,
        content: [
          `继续当前${label}阶段。`,
          // 同上：followUp 轮不触发 before_agent_start，锚点必须内联，防止跨任务读串。
          taskAnchor(),
          "以下是上一版候选基线，保留用户未明确否定的内容，只修改受补充影响的字段。",
          baseline,
          `用户补充：${answer}`,
          `修订完成后重新调用 ${tool}，提交完整合并后的候选${label}。`,
        ].join("\n\n"),
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  /** R3：用 state.steps 重建执行节点列表文本（供 agent_end 的 execute 分隔符复用）。 */
  function renderStepList(): string {
    return state.steps
      .map((step, index) => {
        const dependency =
          step.depends_on.length > 0
            ? `（依赖：${step.depends_on.join(", ")}）`
            : "";
        const acceptance = step.acceptance
          ? `\n   验收：${step.acceptance}`
          : "";
        return `${index + 1}. [${step.id}] ${step.title} [${step.role}]${dependency}\n   职责：${step.responsibility}${acceptance}`;
      })
      .join("\n");
  }

  async function acceptRequirements(
    candidate: RequirementCandidate,
    ctx: ExtensionContext,
  ): Promise<void> {
    const path = writeArtifact(
      "requirements",
      "REQUIREMENTS.md",
      candidate.markdown,
    );
    const contentHash = createHash("sha256")
      .update(candidate.markdown)
      .digest("hex");
    writeArtifact(
      "requirements",
      "manifest.json",
      JSON.stringify(
        {
          artifact_id: "requirements",
          schema_version: "jishu-requirements/v1",
          content_hash: `sha256:${contentHash}`,
          generated_phase: "discuss",
          generated_session_id: ctx.sessionManager.getSessionId(),
          task_id: state.artifacts.taskId ?? "draft",
          skill_pack: `jishu-conductor-${state.domain}`,
          skill_pack_hash: `sha256:${createHash("sha256").update(loadSkill(state.domain, "discuss")).digest("hex")}`,
          linked_revision_id: null,
        },
        null,
        2,
      ),
    );
    state.artifacts.requirements = path;
    // Phase 2：同步阶段到 Hub TaskInstance（discuss→plan）
    const synced = await syncHubPhase(ctx, {
      task_id: state.artifacts.taskId ?? "draft",
      project_root: process.cwd(),
      phase: "plan",
      domain: state.domain,
      artifacts: { requirements: path },
      expected_phase: "discuss",
      artifact_hash: `sha256:${contentHash}`,
      title: candidate.title,
      session_id: ctx.sessionManager.getSessionId(),
    });
    if (!synced) return;

    state.candidate = undefined;
    state.pendingConfirmation = undefined;
    state.revisionInstruction = undefined;
    state.enteringPhase = "plan"; // 铁律7：推迟到 turn_end 落 phase，避免同轮 lock→commit 一跳到底
    persist();
    // R3：驱动下一阶段轮次+持久化分隔符移到空闲 agent_end（消费 pendingDrive），此处不再发送。
  }

  async function acceptPlan(
    candidate: PlanCandidate,
    ctx: ExtensionContext,
  ): Promise<void> {
    validatePlan(candidate.nodes);
    const plan = {
      schema: "jishu-flow-plan-proposal/v1",
      domain: state.domain,
      goal: state.goal,
      requirements_ref: state.artifacts.requirements
        ? "artifact://requirements/REQUIREMENTS.md"
        : undefined,
      nodes: candidate.nodes,
      generated_at: candidate.generatedAt,
    };
    const json = JSON.stringify(plan, null, 2);
    const jsonPath = writeArtifact("planning", "flow-plan-proposal.json", json);
    const mdPath = writeArtifact(
      "planning",
      "flow-plan.md",
      candidate.markdown,
    );
    const contentHash = createHash("sha256").update(json).digest("hex");
    writeArtifact(
      "planning",
      "manifest.json",
      JSON.stringify(
        {
          artifact_id: "planning",
          schema_version: "jishu-flow-plan-proposal/v1",
          content_hash: `sha256:${contentHash}`,
          generated_phase: "plan",
          generated_session_id: ctx.sessionManager.getSessionId(),
          task_id: state.artifacts.taskId ?? "draft",
          skill_pack: `jishu-conductor-${state.domain}`,
          skill_pack_hash: `sha256:${createHash("sha256").update(loadSkill(state.domain, "plan")).digest("hex")}`,
          linked_revision_id: null,
        },
        null,
        2,
      ),
    );

    state.artifacts.flowPlanJson = jsonPath;
    state.artifacts.flowPlanMd = mdPath;
    state.steps = candidate.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      responsibility: node.responsibility,
      acceptance: node.acceptance ?? "",
      depends_on: node.depends_on,
      role: node.role ?? "developer",
      status: "pending",
    }));

    // Phase 3：尝试创建 GraphRevision（orchestrator 模式）
    state.executorMode = "fallback";
    const validateResult = await hubInvoke(ctx, "orchestrator_validate_proposal", {
      task_id: state.artifacts.taskId ?? "draft",
      project_root: process.cwd(),
      proposal_path: jsonPath,
    }, 10000);
    if (validateResult?.success && validateResult.data) {
      state.executorMode = "external";
    }

    // Phase 2：同步阶段到 Hub TaskInstance（plan→execute），携带产物哈希校验
    const synced = await syncHubPhase(ctx, {
      task_id: state.artifacts.taskId ?? "draft",
      project_root: process.cwd(),
      phase: "execute",
      domain: state.domain,
      artifacts: { flow_plan_json: jsonPath, flow_plan_md: mdPath },
      expected_phase: "plan",
      artifact_hash: `sha256:${contentHash}`,
      session_id: ctx.sessionManager.getSessionId(),
    });
    if (!synced) return;

    state.candidate = undefined;
    state.pendingConfirmation = undefined;
    state.revisionInstruction = undefined;
    state.enteringPhase = "execute"; // 铁律7：推迟到 turn_end 落 phase
    persist();
    // R3：进入执行的驱动/分隔符移到空闲 agent_end（消费 pendingDrive），节点列表用 renderStepList() 重建。
  }

  pi.registerTool({
    name: "lock_requirement",
    label: "提交候选需求",
    description: "提交结构化候选需求；用户确认进入规划后才写正式需求终稿。",
    parameters: Type.Object({
      title: Type.String({ description: "任务标题" }),
      goal: Type.String({ description: "一句话目标" }),
      scope: Type.String({ description: "范围（分号分隔）" }),
      out_scope: Type.Optional(
        Type.String({ description: "范围外（分号分隔）" }),
      ),
      constraints: Type.Optional(
        Type.String({ description: "约束条件（分号分隔）" }),
      ),
      acceptance: Type.String({ description: "验收标准（分号分隔）" }),
      assumptions: Type.Optional(
        Type.String({ description: "关键假设（分号分隔）" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const revision =
        state.candidate?.kind === "requirements"
          ? state.candidate.revision + 1
          : 1;
      const candidate: RequirementCandidate = {
        kind: "requirements",
        id: `requirements_${Date.now().toString(36)}_${revision}`,
        revision,
        ...params,
        markdown: renderRequirement(params),
      };
      state.candidate = candidate;
      state.pendingConfirmation = {
        id: `gate_${Date.now().toString(36)}`,
        kind: "requirements-to-plan",
        candidateId: candidate.id,
      };
      state.revisionInstruction = undefined;
      persist();
      // #2（补丁2/R1）：候选全文改由 agent 在调用本工具前于回复中总结呈现（Hub 会丢弃 role=custom 展示消息），此处只弹简短确认卡
      const choice = await ctx.ui.select(
        `请查阅上方候选需求（第 ${revision} 版）是否已满足、是否还有补充。`,
        ["进入流程规划", "继续补充需求"],
      );
      if (choice === "进入流程规划") {
        await acceptRequirements(candidate, ctx);
      } else if (choice !== undefined) {
        // R5：choice 可能是按钮「继续补充需求」，也可能是用户自由输入的补充内容。
        // 后者必须把用户原话带给 agent（基线行为），否则用户的补充被丢弃、agent 只收到套话。
        queueRevision(
          "requirements",
          choice === "继续补充需求"
            ? "请继续补充需求；只询问尚未明确或需要修改的一个维度。"
            : choice,
        );
      }
      // I1：terminate/话术以 accept 是否真正成功为准（acceptRequirements 内 Hub 同步失败会
      // early-return 且不置 enteringPhase）。避免 Hub 失败时"当轮停 + 显示已进入"却无人推进的静默卡死。
      const advanced = choice === "进入流程规划" && state.enteringPhase === "plan";
      // R6：修订分支（已登记 pendingRevise）也当轮停，交空闲 agent_end 单一驱动修订轮。
      const stopNow = advanced || state.pendingRevise !== undefined;
      return {
        content: [
          {
            type: "text" as const,
            text:
              choice === "进入流程规划"
                ? advanced
                  ? "候选需求已确认，进入流程规划。"
                  : "需求阶段同步未成功，请稍后重新确认。"
                : "已收到补充，正在按你的意见修订需求。",
          },
        ],
        details: { candidateId: candidate.id, revision },
        // R3/R6：进入规划 或 修订 → 当轮停，交空闲 agent_end 驱动（避免流式态 followUp 错乱）
        terminate: stopNow,
      };
    },
  });

  pi.registerTool({
    name: "commit_plan",
    label: "提交候选计划",
    description: "提交结构化候选计划；用户确认进入执行后才写正式计划文件。",
    parameters: Type.Object({
      nodes: Type.Array(
        Type.Object({
          id: Type.String({ description: "节点 id" }),
          title: Type.String({ description: "节点标题" }),
          responsibility: Type.String({ description: "职责描述" }),
          depends_on: Type.Array(Type.String(), {
            description: "前置依赖节点 id 列表",
          }),
          acceptance: Type.Optional(Type.String({ description: "验收口径" })),
          role: Type.Optional(Type.String({ description: "建议角色，仅限：developer / tester / architect / reviewer / researcher" })),
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      validatePlan(params.nodes);
      const revision =
        state.candidate?.kind === "plan" ? state.candidate.revision + 1 : 1;
      const candidate: PlanCandidate = {
        kind: "plan",
        id: `plan_${Date.now().toString(36)}_${revision}`,
        revision,
        generatedAt: Date.now(),
        nodes: params.nodes,
        markdown: renderPlan(params.nodes),
      };
      state.candidate = candidate;
      state.pendingConfirmation = {
        id: `gate_${Date.now().toString(36)}`,
        kind: "plan-to-execute",
        candidateId: candidate.id,
      };
      state.revisionInstruction = undefined;
      persist();
      // #2（补丁2/R1）：候选全文改由 agent 在调用本工具前于回复中总结呈现（Hub 会丢弃 role=custom 展示消息），此处只弹简短确认卡
      const choice = await ctx.ui.select(
        `请查阅上方候选计划（第 ${revision} 版）是否合适、是否需要修改。`,
        ["进入流程执行", "修改计划"],
      );
      if (choice === "进入流程执行") {
        await acceptPlan(candidate, ctx);
      } else if (choice !== undefined) {
        // R5：choice 可能是按钮「修改计划」，也可能是用户自由输入的修改要求。后者原样带给 agent。
        queueRevision(
          "plan",
          choice === "修改计划"
            ? "请继续修改计划；只询问尚未明确或需要修改的一个问题。"
            : choice,
        );
      }
      // I1：terminate/话术以 accept 是否真正成功为准（acceptPlan 内 Hub 同步失败会 early-return 且不置 enteringPhase）。
      const advanced = choice === "进入流程执行" && state.enteringPhase === "execute";
      // R6：修订分支（已登记 pendingRevise）也当轮停，交空闲 agent_end 单一驱动修订轮。
      const stopNow = advanced || state.pendingRevise !== undefined;
      return {
        content: [
          {
            type: "text" as const,
            text:
              choice === "进入流程执行"
                ? advanced
                  ? state.executorMode === "external"
                    ? "候选计划已确认。执行图已生成，请在执行工作台为节点选择智能体并点击“执行”。"
                    : "候选计划已确认，进入流程执行。"
                  : "执行阶段同步未成功，请稍后重新确认。"
                : "已收到修改意见，正在按你的意见修订计划。",
          },
        ],
        details: { candidateId: candidate.id, revision },
        terminate: stopNow,
      };
    },
  });

  pi.on("agent_start", async () => {
    terminalStopReason = undefined;
  });

  // R3：空闲态驱动器——turn_end 落地某阶段后由此启下一阶段轮次并持久化分隔符。
  // 只做驱动+分隔符，绝不含 ctx.ui.select（关卡 select 仍在工具内）。
  pi.on("agent_end", async () => {
    // R6：优先消费修订（用户在关卡里补充/改）——空闲态单一驱动，避免流式 followUp 双驱动。
    const revise = state.pendingRevise;
    if (revise) {
      state.pendingRevise = undefined;
      persist();
      driveRevision(revise.kind, revise.answer);
      return;
    }
    const target = state.pendingDrive;
    if (!target) return;
    state.pendingDrive = undefined;
    persist();
    // external 模式的 execute 不驱动模型轮（工作台执行）；plan 与 fallback-execute 需要驱动
    const needDrive =
      target === "plan" ||
      (target === "execute" && state.executorMode !== "external");
    // external execute：不驱动、也不发续轮消息。agent_end 时 run 尚未 settle（isStreaming 仍 true），
    // 发无 deliverAs 的消息会被当 steer 多跑一轮 —— 故此处直接返回。
    //
    // 上述结论已于 2026-07-25 用 pi 源码核实（third_party/pi/packages/coding-agent/
    // src/core/agent-session.ts）：isStreaming 即 _isAgentRunActive（:864），仅在
    // _emitAgentSettled 的 :561 置 false，而 agent_end 扩展钩子在 :704-705 先运行
    // ⇒ 此刻 sendCustomMessage(:1417) 必然落入 :1432 的 isStreaming 分支（steer/followUp），
    // 两者都会多跑一轮。deliverAs:"nextTurn"（:1430）虽不触发轮次，但只 push
    // _pendingNextTurnMessages（:1431，仅在下次用户 prompt 时作上下文注入，见 :1206-1210），
    // **不发 message_start、不落盘** ⇒ 界面与重载都看不到，同样达不到目的。
    //
    // 本阶段不再补发任何说明消息（2026-07-25 用户决定）：流程规划阶段已逐节点确认过
    // 职责，execute 阶段无需重复说明。阶段导航由 TaskPhaseNavBar 标签页承担，其状态
    // 取自 TaskInstance.current_phase（derivePhaseDisplayState），**不依赖分隔符事件**；
    // 任务模式亦不渲染分隔线（见 06-手测反馈修复.md #3）。
    if (!needDrive) return;
    // 注意：本条由 agent_end 发出，落 steer/followUp 分支 ⇒ **不触发 before_agent_start**
    // （见上方 2026-07-25 pi 源码核实结论），因此任务隔离锚点必须内联进正文，
    // 不能指望 before_agent_start 注入 —— 否则模型会在 `.jishu-hub/tasks/` 下自行
    // 搜索需求终稿，扫到同项目的上一个任务（2026-08-02 手测缺陷）。
    const content =
      target === "plan"
        ? [
            "进入流程规划阶段。",
            taskAnchor(),
            "读取上述需求终稿并设计任务节点方案；先在回复列出方案，再调用 commit_plan。",
          ].join("\n\n")
        : [
            "进入流程执行阶段。",
            taskAnchor(),
            `按已确认节点依次执行：\n${renderStepList()}\n全部完成后简要报告产出。`,
          ].join("\n\n");
    pi.sendMessage(
      { customType: `jishu-conductor:phase-enter:${target}`, display: true, content },
      { triggerTurn: needDrive }, // 驱动下一阶段轮次（plan / fallback-execute）
    );
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message as { stopReason?: string };
    terminalStopReason =
      ctx.signal?.aborted === true ? "aborted" : message.stopReason;

    // 铁律7：轮内确认关卡只登记 enteringPhase，真正 setPhase 在此（轮末）统一落地，
    // 避免同一 turn 内 lock→commit 一跳到底 / 进入 execute 后立即动写工具。
    if (state.enteringPhase) {
      if (terminalStopReason === "aborted") {
        state.enteringPhase = undefined; // 用户中止 → 不推进，候选/产物保留
        persist();
        return;
      }
      const next = state.enteringPhase;
      state.enteringPhase = undefined;
      setPhase(next, ctx); // setPhase 内部已 persist（此时 enteringPhase 已清空）
      state.pendingDrive = next; // R3：标记待驱动，空闲 agent_end 消费并启下一阶段轮次+持久化分隔符
      persist(); // setPhase 后又改了 pendingDrive，需再落盘
      return; // 本轮仅落阶段，不再跑完成态判定
    }

    if (state.phase === "execute" && terminalStopReason === "stop") {
      // external 模式：完成态由 Hub 权威，turn_end 不推进 done
      if (state.executorMode === "external") return;
      const synced = await syncHubPhase(ctx, {
        task_id: state.artifacts.taskId ?? "draft",
        project_root: process.cwd(),
        phase: "done",
        domain: state.domain,
        expected_phase: "execute",
      });
      if (!synced) return;
      for (const step of state.steps) step.status = "done";
      setPhase("done", ctx);
      ctx.ui.notify(`流程执行完成。共 ${state.steps.length} 个节点。`, "info");
    }
  });

  pi.registerCommand("jishu-task", {
    description: "启动任务工作流：/jishu-task <dev|research> <需求>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const domainArg = parts[0] as Domain;
      if (!DOMAINS.includes(domainArg)) {
        ctx.ui.notify(
          `未知领域：${domainArg}。支持：${DOMAINS.join(", ")}`,
          "warning",
        );
        return;
      }
      const goal = parts.slice(1).join(" ").trim();
      if (!goal) {
        ctx.ui.notify(
          "请提供任务目标，例如：/jishu-task dev 实现一个登录功能",
          "warning",
        );
        return;
      }
      if (state.phase !== "idle") {
        ctx.ui.notify(
          `已有任务流程正在运行（当前：${phaseDisplayName(state.phase)}），请先完成或取消`,
          "warning",
        );
        return;
      }
      state.domain = domainArg;
      state.goal = goal;
      state.artifacts.taskId = `task_${Date.now().toString(36)}`;
      if (!toolsBeforeWorkflow) toolsBeforeWorkflow = pi.getActiveTools();

      // Phase 2：创建 TaskInstance（任务 2.5：Hub 任务创建入口）
      const synced = await syncHubPhase(ctx, {
        task_id: state.artifacts.taskId,
        project_root: process.cwd(),
        phase: "discuss",
        domain: state.domain,
        expected_phase: "idle",
        title: goal.slice(0, 40),
        session_id: ctx.sessionManager.getSessionId(),
      });
      if (!synced) {
        state.goal = "";
        state.artifacts = {};
        return;
      }

      setPhase("discuss", ctx);
      pi.sendUserMessage(`/jishu-task ${args}`);
    },
  });

  pi.on("before_agent_start", async () => {
    if (state.phase === "idle" || state.phase === "done") return;
    // #5：external 模式 execute 阶段不注入"执行者"技能，改注入监督/交棒指令
    if (state.phase === "execute" && state.executorMode === "external") {
      return {
        message: {
          customType: phaseTag(),
          display: false,
          content: `[JISHU-TASK:${state.domain}:execute] === 流程执行（监督态）===\n执行由界面工作台驱动（用户为节点选智能体并点击“执行”，由 Orchestrator 引擎执行）。你不执行任何节点、不调用写工具（write/bash/edit）。本阶段无需你的动作；如用户提问可只读查阅后简答。`,
        },
      };
    }
    const skill = loadSkill(state.domain, state.phase as SkillPhase);
    const revisionContext =
      state.revisionInstruction && state.candidate
        ? [
            "[REVISION CONTEXT]",
            `用户补充：${state.revisionInstruction}`,
            "上一版候选基线：",
            state.candidate.markdown,
            "只修改受补充影响的内容，保留未被明确否定的字段；完成后提交完整替代候选。",
          ].join("\n\n")
        : "";
    return {
      message: {
        customType: phaseTag(),
        display: false,
        content: `[JISHU-TASK:${state.domain}:${state.phase}] === ${phaseDisplayName(state.phase)} ===\n${skill}\n\n${phaseDiscipline(state.phase)}\n\n${taskAnchor()}${revisionContext ? `\n\n${revisionContext}` : ""}`,
      },
    };
  });

  pi.on("context", async (event) => {
    if (state.phase === "idle") return;
    const current = phaseTag();
    return {
      messages: event.messages.filter((message) => {
        const item = message as AgentMessage & { customType?: string };
        return (
          !item.customType?.startsWith("jishu-conductor:phase:") ||
          item.customType === current
        );
      }),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    type Entry = {
      type: string;
      customType?: string;
      data?: Partial<ConductorState> & { toolsBeforeWorkflow?: string[] };
    };
    const last = (ctx.sessionManager.getEntries() as Entry[])
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === "jishu-conductor",
      )
      .pop();
    if (last?.data) {
      Object.assign(state, last.data, { schemaVersion: 3 });
      state.artifacts ??= {};
      state.steps ??= [];
      // M3：瞬态驱动字段不跨会话恢复，避免窄窗口崩溃后重载残留 → agent_end 误驱动一轮。
      state.enteringPhase = undefined;
      state.pendingDrive = undefined;
      state.pendingRevise = undefined;
      toolsBeforeWorkflow = last.data.toolsBeforeWorkflow;
    }

    // Phase 2（任务 2.6）：从 Hub 拉取 TaskInstance 权威状态，覆盖 appendEntry。
    // 冲突时以 TaskInstance 为准。appendEntry 只补派侧 UI 状态。
    if (state.phase !== "idle" && state.artifacts.taskId) {
      const hubState = await hubInvoke(ctx, "conductor_load_task_state", {
        project_root: process.cwd(),
        task_id: state.artifacts.taskId,
      });
      if (hubState?.success && hubState.data) {
        const data = hubState.data as {
          found: boolean;
          instance?: {
            current_phase: string;
            status: string;
            run_status: string | null;
          };
        };
        if (data.found && data.instance) {
          const inst = data.instance;
          // Hub current_phase → Conductor phase 映射
          let hubPhase: Phase;
          switch (inst.current_phase) {
            case "requirements":
              hubPhase = "discuss";
              break;
            case "planning":
              hubPhase = "plan";
              break;
            case "execution":
              hubPhase = inst.run_status === "completed" ? "done" : "execute";
              break;
            default:
              hubPhase = state.phase;
          }
          // TaskInstance 为准：覆盖本地 phase
          if (hubPhase !== state.phase) {
            state.phase = hubPhase;
            persist();
          }
        }
      }
    }

    if (state.phase !== "idle") {
      const allowed = allowedToolsFor(state.phase, state.executorMode);
      if (allowed) pi.setActiveTools(allowed);
    }
  });

  pi.on("tool_call", async (event) => {
    const allowed = allowedToolsFor(state.phase, state.executorMode);
    if (allowed && !allowed.includes(event.toolName)) {
      return {
        block: true,
        reason: `${state.phase} 阶段不允许 ${event.toolName}`,
      };
    }
    if (state.phase === "idle" || state.phase === "done") return;

    // 任务隔离硬闸门：同一 project_root 下并存多个任务时，模型会用 ls/find/read
    // 在 `.jishu-hub/tasks/` 下"找需求终稿"，从而读到上一个任务的 REQUIREMENTS.md
    // （2026-08-02 手测缺陷：第二个任务按第一个任务的需求出规划）。锚点提示是软约束，
    // 这里做硬拦截。
    const input = (event as { input?: Record<string, unknown> }).input;
    const pathViolation = taskIsolationViolation(
      typeof input?.path === "string" ? input.path : undefined,
    );
    if (pathViolation) return { block: true, reason: pathViolation };
    if (event.toolName === "bash" && typeof input?.command === "string") {
      const cmdViolation = bashTaskIsolationViolation(input.command);
      if (cmdViolation) return { block: true, reason: cmdViolation };
    }
  });
}
