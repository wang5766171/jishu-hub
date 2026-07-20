/**
 * jishu-task-conductor — Pi 扩展，驱动 discuss→plan→execute 三阶段工作流。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
  steps: Step[];
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
  let gateInFlight: string | undefined;

  const persist = (): void => {
    pi.appendEntry("jishu-conductor", { ...state, toolsBeforeWorkflow });
  };

  function artifactsDir(): string {
    const taskId = state.artifacts.taskId || "draft";
    return join(process.cwd(), ".jishu-hub", "tasks", taskId, "artifacts");
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
    const allowed = PHASE_ALLOWED_TOOLS[phase];
    if (allowed) pi.setActiveTools(allowed);
    else if (toolsBeforeWorkflow) pi.setActiveTools(toolsBeforeWorkflow);
    ctx.ui.setStatus("jishu-conductor-phase", phase);
    persist();
  }

  function queueRevision(kind: "requirements" | "plan", answer: string): void {
    state.pendingConfirmation = undefined;
    state.revisionInstruction = answer;
    persist();
    const baseline =
      state.candidate?.kind === kind
        ? kind === "requirements"
          ? state.candidate.markdown
          : state.candidate.markdown
        : "";
    const label = kind === "requirements" ? "需求" : "计划";
    pi.sendMessage(
      {
        customType: `jishu-conductor:revise:${kind}`,
        display: false,
        content: [
          `继续当前${label}阶段。`,
          "以下是上一版候选基线，保留用户未明确否定的内容，只修改受补充影响的字段。",
          baseline,
          `用户补充：${answer}`,
          kind === "requirements"
            ? "修订完成后重新调用 lock_requirement，提交完整合并后的候选需求。"
            : "修订完成后重新调用 commit_plan，提交完整合并后的候选计划。",
        ].join("\n\n"),
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
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
    setPhase("plan", ctx);
    pi.sendMessage(
      {
        customType: "jishu-conductor:phase-enter:plan",
        display: true,
        content: `进入流程规划阶段。读取需求终稿（${path}），逐步澄清流程缺口并设计任务节点方案；明确后调用 commit_plan。`,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
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
    setPhase("execute", ctx);

    const stepList = state.steps
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
    pi.sendMessage(
      {
        customType: "jishu-conductor:phase-enter:execute",
        display: true,
        content: `进入流程执行阶段。按以下已确认节点依次执行：\n${stepList}\n\n全部完成后简要报告产出。`,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
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
    async execute(_id, params) {
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
      return {
        content: [
          {
            type: "text" as const,
            text: `候选需求已准备（第 ${revision} 版），等待用户确认后写入正式终稿。\n\n${candidate.markdown}`,
          },
        ],
        details: { candidateId: candidate.id, revision },
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
          role: Type.Optional(Type.String({ description: "建议角色" })),
        }),
      ),
    }),
    async execute(_id, params) {
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
      return {
        content: [
          {
            type: "text" as const,
            text: `候选计划已准备（第 ${revision} 版），等待用户确认后写入正式计划。\n\n${candidate.markdown}`,
          },
        ],
        details: { candidateId: candidate.id, revision },
      };
    },
  });

  pi.on("agent_start", async () => {
    terminalStopReason = undefined;
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message as { stopReason?: string };
    terminalStopReason =
      ctx.signal?.aborted === true ? "aborted" : message.stopReason;
    if (state.phase === "execute" && terminalStopReason === "stop") {
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

  pi.on("agent_end", async (_event, ctx) => {
    const gate = state.pendingConfirmation;
    const candidate = state.candidate;
    if (terminalStopReason !== "stop" || !gate || !candidate) return;
    if (gate.candidateId !== candidate.id || gateInFlight === gate.id) return;

    gateInFlight = gate.id;
    try {
      if (
        gate.kind === "requirements-to-plan" &&
        candidate.kind === "requirements"
      ) {
        const choice = await ctx.ui.select(
          "候选需求已明确，是否进入流程规划？",
          ["进入流程规划", "继续补充需求"],
        );
        if (choice === undefined) return;
        if (choice === "进入流程规划") {
          await acceptRequirements(candidate, ctx);
        } else {
          queueRevision(
            "requirements",
            choice === "继续补充需求"
              ? "请继续补充需求；只询问尚未明确或需要修改的一个维度。"
              : choice,
          );
        }
        return;
      }

      if (gate.kind === "plan-to-execute" && candidate.kind === "plan") {
        const choice = await ctx.ui.select(
          "候选计划已明确，是否进入流程执行？",
          ["进入流程执行", "修改计划"],
        );
        if (choice === undefined) return;
        if (choice === "进入流程执行") {
          await acceptPlan(candidate, ctx);
        } else {
          queueRevision(
            "plan",
            choice === "修改计划"
              ? "请继续修改计划；只询问尚未明确或需要修改的一个问题。"
              : choice,
          );
        }
      }
    } finally {
      gateInFlight = undefined;
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
        content: `[JISHU-TASK:${state.domain}:${state.phase}] === ${phaseDisplayName(state.phase)} ===\n${skill}\n\n${phaseDiscipline(state.phase)}${revisionContext ? `\n\n${revisionContext}` : ""}`,
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
      const allowed = PHASE_ALLOWED_TOOLS[state.phase];
      if (allowed) pi.setActiveTools(allowed);
    }
  });

  pi.on("tool_call", async (event) => {
    const allowed = PHASE_ALLOWED_TOOLS[state.phase];
    if (!allowed) return;
    if (!allowed.includes(event.toolName)) {
      return {
        block: true,
        reason: `${state.phase} 阶段不允许 ${event.toolName}`,
      };
    }
  });
}
