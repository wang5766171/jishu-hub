/**
 * jishu-task-conductor — Pi 扩展，驱动 discuss→plan→execute 三阶段工作流。
 *
 * Phase 1 骨架：启动命令 + phase 状态机 + appendEntry 恢复 + skill 注入 + context 过滤 + 工具门。
 * 后续步骤追加：lock_requirement/commit_plan 工具（步骤 2）、agent_end 关卡（步骤 2）、fallback 执行（步骤 3）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    requirements?: string;
    flowPlanMd?: string;
    flowPlanJson?: string;
  };
}

// ── 常量 ──
const DOMAINS: Domain[] = ["dev"]; // Phase 6 再开 research

const PHASE_ALLOWED_TOOLS: Partial<Record<Phase, string[]>> = {
  discuss: ["read", "grep", "find", "ls"],
  plan: ["read", "grep", "find", "ls"],
  // execute: external 交给 Hub；fallback 用 FALLBACK_EXECUTE_ALLOWED_TOOLS（步骤 3）
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
      if (!toolsBeforeWorkflow) {
        toolsBeforeWorkflow = pi.getActiveTools();
      }
      setPhase("discuss", ctx);
      pi.sendUserMessage(
        `[\u542f\u52a8\u4efb\u52a1\u5de5\u4f5c\u6d41:${state.domain}] \u76ee\u6807\uff1a${state.goal}\n`
          + "\u4f60\u662f\u9700\u6c42\u6f84\u6e05\u8005\u3002\u5148\u901a\u8fc7\u591a\u8f6e\u5bf9\u8bdd\u6f84\u6e05\u9700\u6c42\uff08\u6bcf\u6b21\u53ea\u95ee\u4e00\u4e2a\u6838\u5fc3\u7ef4\u5ea6\uff09\u3002"
          + "\u9700\u6c42\u6536\u655b\u540e\u8bf4\u660e\"\u9700\u6c42\u5df2\u6f84\u6e05\"\uff0c\u5217\u51fa\u8981\u70b9\uff08\u76ee\u6807/\u8303\u56f4/\u7ea6\u675f/\u9a8c\u6536\uff09\u3002",
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
