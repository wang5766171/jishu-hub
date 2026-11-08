/**
 * jishu-task-runner — Pi 扩展，任务模式执行器（v0.9.7 需求2 去阶段化）。
 *
 * 取代 jishu-task-conductor 的三阶段状态机（discuss→plan→execute）：
 * 用户在**一个对话流**里说目标，agent 自主拆步骤（update_steps）、可并行
 * 派发执行节点（dispatch_to_node）、需要用户拿主意时对话式提问（ask_user）。
 * 呈现纪律：过程不播报，结果/需决策/无法继续才开口；进度由任务卡状态灯
 * 承担（steps 持久化 → runner_update_steps → 前端任务卡）。
 *
 * 自 conductor 保留：appendEntry 持久化（新 schema jishu-task-runner，旧
 * jishu-conductor 条目不读取——不兼容是预期，B3 不做迁移）；hubInvoke 桥
 * （select 通道编码）；session_start 恢复 + runner_load_task_state 权威
 * 覆盖；任务隔离锚点/硬闸门（read 工具路径与 bash 命令双通道）。
 * 删除：phase 状态机、PHASE_ALLOWED_TOOLS、阶段确认卡、enteringPhase/
 * pendingDrive/pendingRevise、lock_requirement/commit_plan/commit_stage、
 * 阶段产物哈希门控。
 */
import { isAbsolute, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface RunnerStep {
  id: string;
  title: string;
  status: "todo" | "running" | "done" | "failed";
}

interface RunnerState {
  schemaVersion: 1;
  taskId: string;
  goal: string;
  steps: RunnerStep[];
  /** agent 需要用户拿主意时的对话式提问（任务卡同步显示；用户回复后清除）。 */
  pendingQuestion?: { question: string; options?: string[] };
}

function emptyState(): RunnerState {
  return { schemaVersion: 1, taskId: "", goal: "", steps: [] };
}

export default function taskRunnerExtension(pi: ExtensionAPI) {
  let state: RunnerState = emptyState();

  const persist = (): void => {
    pi.appendEntry("jishu-task-runner", state);
  };

  // ── 任务隔离（自 conductor 原样保留：跨任务串台是实测过的污染源）──

  function taskAnchor(): string {
    const taskId = state.taskId || "draft";
    const lines = [
      "【任务隔离锚点 — 强制遵守】",
      `- 当前任务 ID：${taskId}`,
      `- 本任务目录：${join(process.cwd(), ".jishu-hub", "tasks", taskId)}`,
      "- 🚫 严禁读取或引用 `.jishu-hub/tasks/` 下**其它任务目录**的任何文件。",
      "- 🚫 严禁用 ls/find/grep 在 `.jishu-hub/tasks/` 下搜索文件；只能访问本任务目录，路径不存在时直接说明。",
    ];
    return lines.join("\n");
  }

  function taskIsolationViolation(rawPath: string | undefined): string | null {
    if (typeof rawPath !== "string" || !rawPath.trim()) return null;
    const taskId = state.taskId || "draft";
    const normalized = (isAbsolute(rawPath) ? rawPath : join(process.cwd(), rawPath))
      .replace(/\\/g, "/")
      .toLowerCase();
    const marker = "/.jishu-hub/tasks";
    const at = normalized.indexOf(marker);
    if (at === -1) return null;
    const rest = normalized.slice(at + marker.length).replace(/^\/+/, "");
    if (!rest) {
      return `禁止列举/搜索 .jishu-hub/tasks 根目录：那里并存多个历史任务。当前任务是 ${taskId}，只能访问它自己的目录。`;
    }
    if (rest.split("/")[0] === taskId.toLowerCase()) return null;
    return `禁止访问其它任务的目录（当前任务是 ${taskId}）。跨任务读取会让成果串台，请只使用本任务目录。`;
  }

  function bashTaskIsolationViolation(command: string): string | null {
    const lowered = command.replace(/\\/g, "/").toLowerCase();
    if (!lowered.includes(".jishu-hub/tasks")) return null;
    const taskId = (state.taskId || "draft").toLowerCase();
    const re = /\.jishu-hub\/tasks(\/[^\s"';|&)]*)?/g;
    let match = re.exec(lowered);
    while (match !== null) {
      const segment = (match[1] ?? "").replace(/^\/+/, "").split("/")[0];
      if (segment !== taskId) {
        return `禁止在命令中访问 .jishu-hub/tasks 下的其它任务目录（当前任务是 ${state.taskId || "draft"}）。`;
      }
      match = re.exec(lowered);
    }
    return null;
  }

  // ── Hub 桥接（自 conductor 原样保留：select 通道编码调用）──

  async function hubInvoke(
    ctx: ExtensionContext,
    command: string,
    params: Record<string, unknown>,
    timeoutMs = 5000,
  ): Promise<{ success: boolean; data?: unknown; error?: string } | null> {
    try {
      const payload = JSON.stringify({ command, params });
      const selectPromise = ctx.ui.select(`\x00hub_invoke:${payload}`, ["\x00ok"]);
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
      return null;
    }
  }

  /** 把 runner 卡片状态（steps + pendingQuestion）同步到 Hub 任务实例
   *（stages_json 列，schema v4 语义=步骤清单；前端任务卡数据源）。
   * R2 issue #5：新任务会话扩展侧无 taskId——传真实 session_id 由 Hub
   * find_by_session 反查；成功返回带 task_id 时写回并持久化（此后直达）。 */
  async function syncRunnerCard(ctx: ExtensionContext): Promise<void> {
    persist();
    if (!state.taskId && !ctx.sessionManager.getSessionId()) return;
    const result = await hubInvoke(
      ctx,
      "runner_update_steps",
      {
        project_root: process.cwd(),
        task_id: state.taskId || undefined,
        session_id: ctx.sessionManager.getSessionId() || undefined,
        steps_json: JSON.stringify({
          steps: state.steps,
          pendingQuestion: state.pendingQuestion ?? null,
        }),
      },
      15000,
    );
    if (result?.success) {
      const data = result.data as { task_id?: string } | undefined;
      if (data?.task_id && !state.taskId) {
        state.taskId = data.task_id;
        persist();
      }
    }
  }

  // ── 会话恢复：先读本会话 appendEntry（jishu-task-runner），再用 Hub
  // 权威实例覆盖（冲突以 TaskInstance 为准——自 conductor 机制保留）──

  pi.on("session_start", async (_event, ctx) => {
    type Entry = {
      type: string;
      customType?: string;
      data?: Partial<RunnerState>;
    };
    const last = (ctx.sessionManager.getEntries() as Entry[])
      .filter((entry) => entry.type === "custom" && entry.customType === "jishu-task-runner")
      .pop();
    if (last?.data) {
      state = {
        schemaVersion: 1,
        taskId: last.data.taskId ?? "",
        goal: last.data.goal ?? "",
        steps: Array.isArray(last.data.steps) ? last.data.steps : [],
        pendingQuestion: last.data.pendingQuestion,
      };
    }
    if (!state.taskId) return;
    const hubState = await hubInvoke(ctx, "runner_load_task_state", {
      project_root: process.cwd(),
      task_id: state.taskId,
    });
    if (hubState?.success && hubState.data) {
      const data = hubState.data as {
        found?: boolean;
        instance?: { title?: string; stages_json?: string | null };
      };
      if (data.found && data.instance) {
        if (data.instance.title) state.goal = data.instance.title;
        if (data.instance.stages_json) {
          try {
            const parsed = JSON.parse(data.instance.stages_json) as {
              steps?: RunnerStep[];
              pendingQuestion?: RunnerState["pendingQuestion"];
            };
            if (Array.isArray(parsed.steps)) {
              state.steps = parsed.steps.filter(
                (s) => s && typeof s.id === "string" && typeof s.title === "string",
              );
            }
          } catch {
            /* 损坏载荷 → 保留会话内恢复值 */
          }
        }
        persist();
      }
    }
  });

  // ── 每轮注入：呈现纪律 + 隔离锚点 + 能力插件提示 ──

  pi.on("before_agent_start", async (event, ctx) => {
    const lines: string[] = [taskAnchor()];
    if (state.goal) {
      lines.push(`【任务目标】${state.goal}`);
    }
    if (state.steps.length > 0) {
      lines.push(
        "【当前步骤】" +
          state.steps.map((s) => `${s.title}（${statusLabel(s.status)}）`).join("；"),
      );
    }
    lines.push(
      "【任务纪律】" +
        "过程不逐句播报（任务卡灯由 update_steps 驱动）；只在结果可用、需要用户决策、无法继续时开口；" +
        "产物落盘后在回复里带 jishu-artifact:// 引用链接；" +
        "破坏性操作（删除/覆盖/安装/提交）先 ask_user 征得同意。",
    );
    // 能力插件联动：启用「需求澄清/计划拆解」时提示为可用能力（非阶段强制）。
    const caps = await hubInvoke(ctx, "runner_capability_plugins", {}, 3000);
    const enabled = (caps?.data as { enabled?: string[] } | undefined)?.enabled ?? [];
    if (enabled.includes("task-requirements")) {
      lines.push("【可用能力】需求澄清：需求模糊时先用它把需求聊清楚、产出结构化需求文档（成果卡呈现，无确认关卡）。");
    }
    if (enabled.includes("task-plan")) {
      lines.push("【可用能力】计划拆解：多步任务先用它出依赖计划草稿（直接展示，用户可插话改，无需确认）。");
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n\n")}` };
  });

  function statusLabel(status: RunnerStep["status"]): string {
    return status === "running"
      ? "进行中"
      : status === "done"
        ? "已完成"
        : status === "failed"
          ? "失败"
          : "待开始";
  }

  // ── 工具闸门：任务隔离硬闸门（保留；阶段白名单已随阶段概念退场）──

  pi.on("tool_call", async (event) => {
    if (!state.taskId) return;
    const input = (event as { input?: Record<string, unknown> }).input;
    const pathViolation = taskIsolationViolation(
      typeof input?.path === "string" ? input.path : undefined,
    );
    if (pathViolation) return { block: true, reason: pathViolation };
    if (event.toolName === "bash" && typeof input?.command === "string") {
      const cmdViolation = bashTaskIsolationViolation(input.command);
      if (cmdViolation) return { block: true, reason: cmdViolation };
    }
    return;
  });

  // ── 工具：update_steps（新增——步骤清单的上报口）──

  pi.registerTool({
    name: "update_steps",
    description:
      "更新任务步骤清单（任务卡状态灯的数据源）。拆解出步骤、状态变化、增删步骤时调用；不要为此在对话里播报。",
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ description: "任务目标（首次拆解时给一次）" })),
      steps: Type.Array(
        Type.Object({
          id: Type.String(),
          title: Type.String(),
          status: Type.Union([
            Type.Literal("todo"),
            Type.Literal("running"),
            Type.Literal("done"),
            Type.Literal("failed"),
          ]),
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const known = new Set(state.steps.map((s) => s.id));
      for (const step of params.steps) {
        if (!known.has(step.id)) known.add(step.id);
      }
      state.steps = params.steps
        .filter((s) => s.id && s.title)
        .map((s) => ({
          id: s.id,
          title: s.title,
          status: (["todo", "running", "done", "failed"] as const).includes(s.status)
            ? s.status
            : "todo",
        }));
      if (params.goal && !state.goal) state.goal = params.goal;
      // 用户已回应过旧问题 → 新一轮步骤更新时清掉过期提问。
      if (state.pendingQuestion) state.pendingQuestion = undefined;
      await syncRunnerCard(ctx as ExtensionContext);
      return `步骤已更新（${state.steps.length} 项）`;
    },
  });

  // ── 工具：dispatch_to_node（保留——并行执行派发口）──

  pi.registerTool({
    name: "dispatch_to_node",
    description:
      "把一个可独立执行的步骤派发给后台执行节点（独立会话并行执行，互不干扰）。适合互不依赖的步骤同时派出。",
    parameters: Type.Object({
      node_id: Type.String({ description: "节点 id（与 update_steps 的步骤 id 对应）" }),
      title: Type.String({ description: "节点标题" }),
      instruction: Type.String({ description: "给执行节点的完整指令（目标/输入/验收）" }),
      agent_id: Type.Optional(Type.String({ description: "指定执行智能体（默认 jishu-self）" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (!state.taskId) {
        return "任务尚未建立（缺 task_id）——先用 update_steps 建立步骤清单后重试。";
      }
      const step = state.steps.find((s) => s.id === params.node_id);
      if (step && step.status !== "running") {
        step.status = "running";
      }
      const result = await hubInvoke(
        ctx as ExtensionContext,
        "conductor_dispatch_to_node",
        {
          project_root: process.cwd(),
          task_id: state.taskId,
          node_id: params.node_id,
          title: params.title,
          instruction: params.instruction,
          agent_id: params.agent_id ?? "jishu-self",
        },
        20000,
      );
      await syncRunnerCard(ctx as ExtensionContext);
      if (!result) return "派发请求未达 Hub（桥接超时）——请稍后重试。";
      if (!result.success) return `派发失败：${result.error ?? "未知错误"}`;
      return `节点 ${params.title} 已派发后台执行；完成后结果会回流，继续观察其余步骤。`;
    },
  });

  // ── 工具：ask_user（新增——对话式决策提问，任务卡同步显示）──

  pi.registerTool({
    name: "ask_user",
    description:
      "需要用户拿主意时提问（选项式）。问题会同时显示在对话流与任务卡上；用户回复后继续。",
    parameters: Type.Object({
      question: Type.String({ description: "问题（一句话，用户语言）" }),
      options: Type.Optional(
        Type.Array(Type.String(), { description: "候选选项（2~4 个，不含『其它』）" }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      state.pendingQuestion = {
        question: params.question,
        options: params.options?.slice(0, 4),
      };
      await syncRunnerCard(ctx as ExtensionContext);
      // 对话式呈现：走 pi 原生 select 问答（与交互问答插件同款通道语义），
      // 用户选择/输入的答案作为工具结果回流给 agent。
      const answer = await (ctx as ExtensionContext).ui.select(
        params.question,
        [...(params.options ?? []), "都不是，我自己说"],
      );
      state.pendingQuestion = undefined;
      await syncRunnerCard(ctx as ExtensionContext);
      return `用户回答：${answer ?? "（未选择）"}`;
    },
  });
}
