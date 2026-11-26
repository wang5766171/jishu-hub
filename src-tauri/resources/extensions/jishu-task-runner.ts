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

/** 需求9 #5：不询问模式硬拦截的提问类工具（npm 扩展 ask_user_question 的
 * 历史注册名变体一并覆盖；ask_user 为 runner 自注册，其 execute 内另有硬放行）。 */
const ASK_TOOLS = new Set([
  "ask_user",
  "ask_user_question",
  "askuserquestion",
  "ask_question",
]);

export default function taskRunnerExtension(pi: ExtensionAPI) {
  let state: RunnerState = emptyState();
  // 需求22（v0.9.8 评审修复轮 R2）：本会话是不是任务会话、开没开「不询问」，
  // 以 hub 的任务登记为准——每轮 before_agent_start 带会话号向 hub 查一次，
  // 工具执行期读这份缓存（执行期不再起一次桥接）。
  // 此前「不询问」读的是全局配置里的一个键：任一会话打开，所有会话（包括
  // 普通对话）一起生效、关不掉；任务锚点和纪律也是对所有会话无条件注入。
  let isTaskSession = false;
  let noAskMode = false;
  /** 最近一次有依据的「是不是任务会话」（null = hub 还没回答过、也没从会话
   * 恢复出任务号）。hub 没回答的那一轮沿用它（评审修复轮 R3 P2-11）。 */
  let taskSessionKnown: boolean | null = null;

  const persist = (): void => {
    pi.appendEntry("jishu-task-runner", state);
  };

  // ── 工具结果包装（v0.9.8 需求1 测试期修复）──
  // pi 扩展工具 execute 契约要求返回 AgentToolResult 对象（content blocks）；
  // 裸字符串经 pi agent-loop `content ?? []` 归一后 content 为空数组——模型
  // 永远收不到工具结果文本（ask_user 的答案因此从未回流模型，会话 JSONL
  // 实证 toolResult content:[]，与 plugin-invoke/html-preview 的正确写法对照）。
  function toolText(text: string) {
    return { content: [{ type: "text" as const, text }], details: {} };
  }

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
        // 需求9 #4：标题随步骤上报（conductor 退役后唯一标题写入链断裂，
        // 实例标题恒为默认「新任务」；goal 首次拆解时捕获）。
        title: state.goal || undefined,
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

  // ── 每轮注入：隔离锚点 + 呈现纪律 + 能力插件提示（只给任务会话）──

  pi.on("before_agent_start", async (event, ctx) => {
    // 需求9 #5：先问 hub 再组纪律文本——旧序先组纪律后刷新，开启不询问后
    // 的第一轮注入的仍是上一轮的询问版纪律。
    // 需求22：带会话号问 hub「本会话是不是任务会话、开没开不询问」。hub 按
    // 自己的任务登记回答——不靠执行器手里的任务编号判断，那个编号要等模型
    // 第一次上报步骤之后才有，单步小任务可能一直都没有。
    const caps = await hubInvoke(
      ctx,
      "runner_capability_plugins",
      {
        session_id: ctx.sessionManager.getSessionId(),
        project_root: process.cwd(),
      },
      3000,
    );
    const capData = caps?.data as
      | { enabled?: string[]; taskSession?: boolean; taskId?: string; noAsk?: boolean }
      | undefined;
    // hub 回答了「是不是任务会话」就听 hub 的，并记住这次回答。没回答（桥超
    // 时 / 出错 / 回答不了）时沿用最近一次有依据的判定：hub 说过是、或上一轮
    // 留下任务号的会话据此刻意是任务会话——任务隔离锚点不能因为 hub 一时没
    // 答就丢（评审修复轮 R3 P2-11；修前锚点是无条件注入的）；hub 说过不是
    // 的，也不会因为一次没回答又变回去。「不询问」只认 hub 的肯定回答，没回
    // 答一律按关。
    const hubAnswered = caps?.success === true && typeof capData?.taskSession === "boolean";
    isTaskSession = hubAnswered
      ? capData?.taskSession === true
      : (taskSessionKnown ?? Boolean(state.taskId));
    taskSessionKnown = isTaskSession;
    // 「不询问」每轮整体重算（评审修复轮 R3 P1-2）：此前只在 hub 说「是任务
    // 会话」时才重新赋值——上一轮为真、这一轮 hub 说「不是任务会话」或没回
    // 答，它保持真值，ask_user 仍不弹、提问类工具仍被拦。
    noAskMode =
      isTaskSession && capData?.taskSession === true && capData?.noAsk === true;
    // hub 的任务号先于模型上报到位：任务卡、隔离闸门、派发从第一轮起就有
    // 真实的任务号可用（此前锚点写的是占位的 draft，要等第一次上报步骤）。
    if (isTaskSession && !state.taskId && capData?.taskId) {
      state.taskId = capData.taskId;
    }
    // 需求22：任务锚点、任务纪律、能力提示只注入任务会话。普通对话（包括
    // hub 没回答、手里也没有任务号的情况）什么都不注入——此前普通对话每轮
    // 都被写进任务纪律，不询问一旦打开，连普通对话也不再向用户提问。
    if (!isTaskSession) return;
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
      noAskMode
        ? "【任务纪律·不询问模式】" +
          "用户已开启不询问模式：**不要向用户提问**（不用 ask_user、不用 ask_user_question），" +
          "一切按你自己的最优判断直接执行到底；破坏性操作也直接执行并在结果中说明理由；" +
          "过程不逐句播报，产物落盘后在回复里带 jishu-artifact:// 引用链接。"
        : "【任务纪律】" +
          "过程不逐句播报（任务卡灯由 update_steps 驱动）；只在结果可用、需要用户决策、无法继续时开口；" +
          "产物落盘后在回复里带 jishu-artifact:// 引用链接；" +
          "破坏性操作（删除/覆盖/安装/提交）先 ask_user 征得同意。",
    );
    // 需求22：引用格式（jishu-artifact:// 相对路径 + 正斜杠）是所有会话通用
    // 的规则，不随任务纪律走——由 session-context 扩展注入每个会话。
    const enabled = capData?.enabled ?? [];
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
    // 需求9 #5：不询问模式硬拦截 npm 扩展的 ask_user_question——原硬放行
    // 只挂 runner 自注册的 ask_user，问答卡实际多来自
    // @juicesharp/rpiv-ask-user-question（含「N. Type something.」追加输入
    // 协议），纪律提示是软约束拦不住它。
    // 需求22：noAskMode 只在本会话是任务会话、且该任务开了开关时为真（hub
    // 每轮回答）——普通会话不会被拦。
    if (noAskMode && ASK_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason:
          "不询问模式已开启：不要向用户提问（含 ask_user/ask_user_question），按自己的最优判断继续执行，结果中说明理由。",
      };
    }
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
      return toolText(`步骤已更新（${state.steps.length} 项）`);
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
        return toolText("任务尚未建立（缺 task_id）——先用 update_steps 建立步骤清单后重试。");
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
      if (!result) return toolText("派发请求未达 Hub（桥接超时）——请稍后重试。");
      if (!result.success) return toolText(`派发失败：${result.error ?? "未知错误"}`);
      return toolText(`节点 ${params.title} 已派发后台执行；完成后结果会回流，继续观察其余步骤。`);
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
      // 不询问模式（需求22：按会话——本任务是任务会话且开了开关，hub 每轮
      // 回答）：不弹问答——按 agent 首个推荐项（或其自行判断）直接放行，
      // 工具结果说明已自动决策。
      if (noAskMode) {
        return toolText(`（不询问模式）已按你的推荐执行：${params.options?.[0] ?? "自行判断"}`);
      }
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
      return toolText(`用户回答：${answer ?? "（未选择）"}`);
    },
  });
}
