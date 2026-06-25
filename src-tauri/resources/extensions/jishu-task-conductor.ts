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
}

// ── 常量 ──
const DOMAINS: Domain[] = ["dev"]; // Phase 6 再开 research

const PHASE_ALLOWED_TOOLS: Partial<Record<Phase, string[]>> = {
  discuss: ["read", "grep", "find", "ls", "lock_requirement", "request_user_input"],
  plan: ["read", "grep", "find", "ls", "commit_plan", "request_user_input"],
  // execute: 步骤 3 实现 FALLBACK_EXECUTE_ALLOWED_TOOLS 前不放开
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
  // 注意：agent_end 在正常完成和用户 abort 时都会触发。
  // 不使用 sendMessage(triggerTurn:true) 自动驱动新 turn——避免用户点停止后 agent 继续输出。
  // 改为 setPhase + notify，让用户自己发消息开始下一阶段（before_agent_start 会自动注入对应 skill）。
  let lastTurnEndedNormally = false;

  pi.on("turn_start", async () => {
    lastTurnEndedNormally = false;
  });

  pi.on("turn_end", async (event) => {
    // stopReason="aborted" 表示用户点了停止——不是正常完成
    const msg = event.message as { stopReason?: string };
    lastTurnEndedNormally = msg?.stopReason !== "aborted";
  });

  pi.on("agent_end", async (_event, ctx) => {
    // 用户 abort（turn_end 没正常触发）→ 不弹确认，不推进
    if (!lastTurnEndedNormally) return;

    if (state.phase === "discuss" && state.artifacts.requirements) {
      const choice = await ctx.ui.select(
        "需求已锁定，是否进入流程规划？",
        ["进入流程规划", "继续补充需求"],
      );
      if (choice?.startsWith("进入")) {
        setPhase("plan", ctx);
        ctx.ui.notify("已进入流程规划阶段。请发送消息开始规划（读取需求终稿，设计节点方案）。", "info");
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
        setPhase("done", ctx);
        ctx.ui.notify("流程规划完成。执行阶段将在后续步骤实现。计划提案已落盘：" + (state.artifacts.flowPlanJson ?? ""), "info");
      } else {
        state.artifacts.flowPlanJson = undefined;
        state.artifacts.flowPlanMd = undefined;
        persist();
      }
      return;
    }
  });

  const persist = (): void => {
    pi.appendEntry("jishu-conductor", { ...state, toolsBeforeWorkflow });
  };

  const phaseTag = (): string =>
    `jishu-conductor:phase:${state.domain}:${state.phase}`;

  function setPhase(phase: Phase, _ctx: ExtensionContext): void {
    state.phase = phase;
    const allowed = PHASE_ALLOWED_TOOLS[phase];
    if (allowed) {
      pi.setActiveTools(allowed);
    } else if (toolsBeforeWorkflow) {
      pi.setActiveTools(toolsBeforeWorkflow);
    }
    pi.sendMessage({
      customType: `jishu-conductor:phase-start:${phase}`,
      display: false, // Hub RPC mode doesn't render display:true messages
      content: `\u2500\u2500 \u8fdb\u5165${phaseDisplayName(phase)}\u9636\u6bb5 \u2500\u2500`,
    });
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
      pi.sendUserMessage(
        `[启动任务工作流:${state.domain}] 目标：${state.goal}\n`
          + "你是需求澄清者。先通过多轮对话澄清需求（每次只问一个核心维度），用 request_user_input 提供选项。\n"
          + "需求收敛后**必须调用 lock_requirement 工具**提交结构化需求终稿，不要只用文本声明。",
      );
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
