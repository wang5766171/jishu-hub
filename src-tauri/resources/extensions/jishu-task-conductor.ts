/**
 * jishu-task-conductor — Pi 扩展，驱动 discuss→plan→execute 三阶段工作流。
 *
 * Phase 1 步骤 1+2：骨架 + 结构化工具 + agent_end 关卡 + 阶段推进。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── 类型 ──
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

interface ConductorState {
  domain: Domain;
  phase: Phase;
  goal: string;
  artifacts: {
    taskId?: string;
    requirements?: string;
    flowPlanMd?: string;
    flowPlanJson?: string;
  };
  steps: Step[];
}

// ── 常量 ──
const DOMAINS: Domain[] = ["dev"]; // Phase 6 再开 research

const PHASE_ALLOWED_TOOLS: Partial<Record<Phase, string[]>> = {
  discuss: ["read", "grep", "find", "ls", "lock_requirement", "request_user_input"],
  plan: ["read", "grep", "find", "ls", "commit_plan", "request_user_input"],
  execute: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

const SKILLS_DIR =
  process.env.JISHU_CONDUCTOR_SKILLS_DIR ||
  join(process.env.HOME || process.env.USERPROFILE || "~", ".jishu-agent", "skills");

// ── 辅助 ──
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

// ── 扩展入口 ──
export default function conductorExtension(pi: ExtensionAPI): void {
  const state: ConductorState = {
    domain: "dev",
    phase: "idle",
    goal: "",
    artifacts: {},
    steps: [],
  };
  let toolsBeforeWorkflow: string[] | undefined;

  // ── 产物目录辅助 ──
  function artifactsDir(): string {
    const cwd = process.cwd();
    const taskId = state.artifacts.taskId || "draft";
    return join(cwd, ".jishu-hub", "tasks", taskId, "artifacts");
  }

  function writeArtifact(subdir: string, filename: string, content: string): string {
    const dir = join(artifactsDir(), subdir);
    mkdirSync(dir, { recursive: true });
    const fullPath = join(dir, filename);
    writeFileSync(fullPath, content, "utf-8");
    return fullPath;
  }

  // ─── 结构化工具：lock_requirement（discuss→plan 提交需求）───
  pi.registerTool({
    name: "lock_requirement",
    label: "锁定需求",
    description: "提交结构化需求终稿，锁定后进入流程规划阶段。需求收敛后调用此工具。",
    parameters: Type.Object({
      title: Type.String({ description: "任务标题" }),
      goal: Type.String({ description: "一句话目标" }),
      scope: Type.String({ description: "范围（分号分隔）" }),
      out_scope: Type.Optional(Type.String({ description: "范围外（分号分隔）" })),
      constraints: Type.Optional(Type.String({ description: "约束条件（分号分隔）" })),
      acceptance: Type.String({ description: "验收标准（分号分隔）" }),
      assumptions: Type.Optional(Type.String({ description: "关键假设（分号分隔）" })),
    }),
    async execute(_id, params) {
      const splitList = (v: string) => v.split(";").map((s) => s.trim()).filter(Boolean);
      const md = [
        `# ${params.title}`, "",
        "## 目标", params.goal, "",
        "## 范围",
        ...splitList(params.scope).map((s, i) => `${i + 1}. ${s}`), "",
      ];
      if (params.out_scope) {
        md.push("## 范围外", ...splitList(params.out_scope).map((s) => `- ${s}`), "");
      }
      if (params.constraints) {
        md.push("## 约束条件", ...splitList(params.constraints).map((s) => `- ${s}`), "");
      }
      md.push("## 验收标准",
        ...splitList(params.acceptance).map((s, i) => `${i + 1}. ${s}`), "");
      if (params.assumptions) {
        md.push("## 关键假设", ...splitList(params.assumptions).map((s) => `- ${s}`), "");
      }
      const content = md.join("\n");
      const path = writeArtifact("requirements", "REQUIREMENTS.md", content);
      state.artifacts.requirements = path;
      persist();
      return {
        content: [{ type: "text" as const, text: `需求终稿已落盘：${path}\n\n${content}` }],
        details: { artifactPath: path },
      };
    },
  });

  // ─── 结构化工具：commit_plan（plan→execute 提交计划提案）───
  pi.registerTool({
    name: "commit_plan",
    label: "提交计划",
    description: "提交结构化流程计划提案，用户确认后进入执行阶段。流程方案稳定后调用此工具。",
    parameters: Type.Object({
      nodes: Type.Array(Type.Object({
        id: Type.String({ description: "节点 id（如 node_1）" }),
        title: Type.String({ description: "节点标题" }),
        responsibility: Type.String({ description: "职责描述" }),
        depends_on: Type.Array(Type.String(), { description: "前置依赖节点 id 列表" }),
        acceptance: Type.Optional(Type.String({ description: "验收口径" })),
        role: Type.Optional(Type.String({ description: "建议角色（developer/tester/architect）" })),
      }), { description: "流程节点列表" }),
    }),
    async execute(_id, params) {
      const plan = {
        schema: "jishu-flow-plan-proposal/v1",
        domain: state.domain,
        goal: state.goal,
        requirements_ref: state.artifacts.requirements
          ? `artifact://requirements/REQUIREMENTS.md`
          : undefined,
        nodes: params.nodes,
        generated_at: Date.now(),
      };
      const md = [
        "## 流程方案", "",
        `共 ${params.nodes.length} 个节点：`, "",
        ...params.nodes.map((n, i) => {
          const dep = n.depends_on.length > 0 ? `（依赖：${n.depends_on.join(", ")}）` : "（无依赖）";
          const role = n.role ? ` [${n.role}]` : "";
          return `${i + 1}. **${n.title}**${role}${dep}\n   - 职责：${n.responsibility}`;
        }),
        "", "---", "",
        "以上为计划提案，等待用户确认后进入执行。",
      ].join("\n");
      const jsonPath = writeArtifact("planning", "flow-plan-proposal.json", JSON.stringify(plan, null, 2));
      const mdPath = writeArtifact("planning", "flow-plan.md", md);
      // manifest（实施计划 1.4：含 hash/task_id/phase/session/revision）
      const crypto = await import("node:crypto");
      const contentHash = crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex");
      const manifest = {
        artifact_id: "planning",
        schema_version: "jishu-flow-plan-proposal/v1",
        content_hash: `sha256:${contentHash}`,
        generated_phase: "plan",
        generated_session_id: "conductor",
        task_id: state.artifacts.taskId ?? "draft",
        skill_pack: `jishu-conductor-${state.domain}`,
        linked_revision_id: null,
      };
      writeArtifact("planning", "manifest.json", JSON.stringify(manifest, null, 2));
      state.artifacts.flowPlanJson = jsonPath;
      state.artifacts.flowPlanMd = mdPath;
      persist();
      return {
        content: [{ type: "text" as const, text: `计划提案已落盘：\n${mdPath}\n${jsonPath}\n\n${md}` }],
        details: { jsonPath, mdPath },
      };
    },
  });

  // ─── agent_end：人工关卡 + 阶段推进 ───
  // agent_end 在正常完成和用户 abort 时都会触发，用 lastTurnEndedNormally 区分
  // （turn_end 据 message.stopReason 置位：正常完成=true，abort=false）。
  // abort 时跳过关卡、不推进阶段——这是「用户点停止后流程不会自行继续」的保障。
  // 正常完成且关卡确认后，再用 sendMessage(triggerTurn:true) 自动驱动下一阶段 turn
  // （discuss→plan→execute 衔接；before_agent_start 会注入对应 skill）。
  let lastTurnEndedNormally = false;

  pi.on("turn_start", async () => {
    lastTurnEndedNormally = false;
  });

  pi.on("agent_end", async (_event, ctx) => {
    // 诊断日志（排查 agent_end 是否触发、条件是否满足）
    console.error(`[jishu-task-conductor] agent_end fired: phase=${state.phase} lastTurnEndedNormally=${lastTurnEndedNormally} requirements=${state.artifacts.requirements ?? "none"} flowPlanJson=${state.artifacts.flowPlanJson ?? "none"}`);
    // 用户 abort（turn_end 没正常触发）→ 不弹确认，不推进
    if (!lastTurnEndedNormally) {
      console.error("[jishu-task-conductor] agent_end skipped: lastTurnEndedNormally=false");
      return;
    }

    if (state.phase === "discuss" && state.artifacts.requirements) {
      const choice = await ctx.ui.select(
        "需求已锁定，是否进入流程规划？",
        ["进入流程规划", "继续补充需求"],
      );
      if (choice?.startsWith("进入")) {
        setPhase("plan", ctx);
        pi.sendMessage(
          {
            customType: "jishu-conductor:phase-enter:plan",
            display: false,
            content: "进入流程规划阶段。读取需求终稿（" + (state.artifacts.requirements ?? "")
              + "），设计任务节点方案。与用户讨论调整后，调用 commit_plan 工具提交。",
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } else {
        state.artifacts.requirements = undefined;
        persist();
      }
      return;
    }

    if (state.phase === "plan" && state.artifacts.flowPlanJson) {
      const choice = await ctx.ui.select(
        "计划提案已提交，是否进入执行？",
        ["进入流程执行", "修改计划"],
      );
      if (choice?.startsWith("进入")) {
        // 读取计划提案，初始化步骤列表
        let plan: { nodes: Array<{ id: string; title: string; responsibility: string; acceptance?: string; depends_on: string[]; role?: string }> } | null = null;
        try {
          const raw = readFileSync(state.artifacts.flowPlanJson ?? "", "utf-8");
          plan = JSON.parse(raw);
        } catch {
          ctx.ui.notify("无法读取计划提案，请重新提交", "warning");
          state.artifacts.flowPlanJson = undefined;
          persist();
          return;
        }
        if (!plan?.nodes?.length) {
          ctx.ui.notify("计划提案无节点，请重新提交", "warning");
          return;
        }
        state.steps = plan.nodes.map((n) => ({
          id: n.id,
          title: n.title,
          responsibility: n.responsibility ?? "",
          acceptance: n.acceptance ?? "",
          depends_on: n.depends_on ?? [],
          role: n.role ?? "developer",
          status: "pending" as const,
        }));
        setPhase("execute", ctx);
        const stepList = state.steps
          .map((s, i) => {
            const dep = s.depends_on.length > 0 ? `（依赖：${s.depends_on.join(", ")}）` : "";
            const acc = s.acceptance ? `\n   验收：${s.acceptance}` : "";
            return `${i + 1}. [${s.id}] ${s.title} [${s.role}]${dep}\n   职责：${s.responsibility}${acc}`;
          })
          .join("\n");
        ctx.ui.notify("进入执行阶段。共 " + state.steps.length + " 个节点。", "info");
        // 一段式执行：单个 turn 内一口气执行完所有节点（不再逐节点 sendMessage 推进）。
        // 这样 abort 走正常 stream 中断（anthropic-messages :379），不存在逐节点 followUp
        // + signal 延迟导致的停止无效。fallback 是过渡态，简单优先。
        pi.sendMessage(
          {
            customType: "jishu-conductor:phase-enter:execute",
            display: false,
            content: "进入流程执行阶段。按以下节点依次执行：\n" + stepList + "\n\n"
              + "按顺序逐个完成。全部完成后简要报告产出。",
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } else {
        state.artifacts.flowPlanJson = undefined;
        state.artifacts.flowPlanMd = undefined;
        persist();
      }
      return;
    }
  });

  // ── turn_end：abort 检测 + execute 一段式收尾（turn 结束即 done）──
  pi.on("turn_end", async (event, ctx) => {
    // abort 检测：一段式单 turn 下 abort 走 stream 中断，ctx.signal.aborted 可靠
    const msg = event.message as { stopReason?: string };
    const aborted = ctx.signal?.aborted === true || msg?.stopReason === "aborted";
    lastTurnEndedNormally = !aborted;

    // execute 一段式：单个 turn 依次执行完所有节点，turn 自然结束 = done。
    // abort 时（lastTurnEndedNormally=false）不进 done。
    if (state.phase !== "execute") return;
    if (!lastTurnEndedNormally) return;
    setPhase("done", ctx);
    ctx.ui.notify("流程执行完成。共 " + state.steps.length + " 个节点。", "info");
  });

  const persist = (): void => {
    pi.appendEntry("jishu-conductor", { ...state, toolsBeforeWorkflow });
  };

  const phaseTag = (): string =>
    `jishu-conductor:phase:${state.domain}:${state.phase}`;

  function setPhase(phase: Phase, ctx: ExtensionContext): void {
    state.phase = phase;
    const allowed = PHASE_ALLOWED_TOOLS[phase];
    if (allowed) {
      pi.setActiveTools(allowed);
    } else if (toolsBeforeWorkflow) {
      pi.setActiveTools(toolsBeforeWorkflow);
    }
    // 发送结构化阶段标记：Pi RPC 转为 extension_ui_request(setStatus)，
    // Hub 的 convert_extension_ui_request 识别后转为 PhaseDivider 事件，
    // 前端渲染为分隔线。
    ctx.ui.setStatus("jishu-conductor-phase", phase);
    persist();
  }

  // ── 启动命令：/jishu-task <domain> <goal> ──
  pi.registerCommand("jishu-task", {
    description: "\u542f\u52a8\u4efb\u52a1\u5de5\u4f5c\u6d41\uff1a/jishu-task <dev|research> <\u9700\u6c42>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const domainArg = parts[0] as Domain;
      if (!DOMAINS.includes(domainArg)) {
        ctx.ui.notify(
          `\u672a\u77e5\u9886\u57df\uff1a${domainArg}\u3002\u652f\u6301\uff1a${DOMAINS.join(", ")}`,
          "warning",
        );
        return;
      }
      const goal = parts.slice(1).join(" ").trim();
      if (!goal) {
        ctx.ui.notify("请提供任务目标，例如：/jishu-task dev 实现一个登录功能", "warning");
        return;
      }
      if (state.phase !== "idle") {
        ctx.ui.notify("已有任务流程正在运行（当前：" + phaseDisplayName(state.phase) + "），请先完成或取消", "warning");
        return;
      }
      state.domain = domainArg;
      state.goal = goal;
      state.artifacts.taskId = `task_${Date.now().toString(36)}`;
      if (!toolsBeforeWorkflow) {
        toolsBeforeWorkflow = pi.getActiveTools();
      }
      setPhase("discuss", ctx);
      // 用 sendUserMessage 把用户指令作为标准 user 消息持久化（slash command 本身不入会话历史，
      // 必须显式补一条，否则重新进入看不到发起指令）；同时触发 discuss 首个 turn。
      // discuss 方法论由 before_agent_start 注入，这里无需再带指令文本。
      pi.sendUserMessage(`/jishu-task ${args}`);
    },
  });

  // ── before_agent_start\uff1a\u6ce8\u5165\u5f53\u524d\u9636\u6bb5\u65b9\u6cd5\u8bba ──
  pi.on("before_agent_start", async () => {
    if (state.phase === "idle" || state.phase === "done") return;
    const skillPhase = state.phase as SkillPhase;
    const skill = loadSkill(state.domain, skillPhase);
    return {
      message: {
        customType: phaseTag(),
        display: false,
        content: `[JISHU-TASK:${state.domain}:${state.phase}] === ${phaseDisplayName(state.phase)} ===\n${skill}`,
      },
    };
  });

  // ── context\uff1a\u8fc7\u6ee4\u975e\u5f53\u524d\u9636\u6bb5\u7684\u6ce8\u5165\u6d88\u606f ──
  pi.on("context", async (event) => {
    if (state.phase === "idle") return;
    const current = phaseTag();
    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        if (
          msg.customType?.startsWith("jishu-conductor:phase:") &&
          msg.customType !== current
        ) {
          return false;
        }
        return true;
      }),
    };
  });

  // ── session_start\uff1a\u6062\u590d\u72b6\u6001 ──
  pi.on("session_start", async (_event, ctx) => {
    type Entry = {
      type: string;
      customType?: string;
      data?: ConductorState & { toolsBeforeWorkflow?: string[] };
    };
    const entries = ctx.sessionManager.getEntries() as Entry[];
    const last = entries
      .filter((e) => e.type === "custom" && e.customType === "jishu-conductor")
      .pop();
    if (last?.data) {
      Object.assign(state, last.data);
      toolsBeforeWorkflow = last.data.toolsBeforeWorkflow;
    }
    if (state.phase !== "idle") {
      const allowed = PHASE_ALLOWED_TOOLS[state.phase];
      if (allowed) pi.setActiveTools(allowed);
    }
  });

  // 工具门兜底：setActiveTools 可能因状态不同步而漏，再拦一层（评审 P1）
  pi.on("tool_call", async (event) => {
    const allowed = PHASE_ALLOWED_TOOLS[state.phase];
    if (!allowed) return; // execute/idle/done 不限制
    if (!allowed.includes(event.toolName)) {
      return { block: true, reason: `${state.phase} 阶段不允许 ${event.toolName}` };
    }
  });
}
