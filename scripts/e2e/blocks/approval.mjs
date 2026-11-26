/**
 * 积木：工具执行审批——同意、不同意、默认不表态（AP-1、AP-2、AP-3）+ 还原（APX-1）。
 * 对应评审修复轮 R2 的用户裁决 9：「测试需要细分成同意和不同意的测试，都应该有对应的自动化测试」，
 * 以及评审 R2-9（测试框架默认替用户放行审批）。用例清单：docs/v0.9.8/评审修复轮-R2/tests/E-用例清单.md。
 *
 * 三条用例的前提相同（不成立就跳过并写明，不假设用户的初始档位）：
 * - 输入区的「访问权限」可以切换，菜单里有会弹审批的档位——优先「变更前审批」（写文件、执行命令每次
 *   都需确认，且这一档不提供「始终允许」），没有它退到「智能审批」（新会话没有记忆，同样会弹）；
 * - 切档时没有任何会话的回合在跑（切档是产品行为：重启该智能体全部会话的引擎进程，别打断用户的回合）；
 * - 模型可用。
 *
 * 每条用例在新对话里让模型用 bash 执行一条无害命令（echo 一个带编号的固定字符串，不落盘、不改任何文件）：
 * - AP-1 等审批卡 → 核对卡上写的就是这条命令 → 点「仅本次允许」→ 命令真的执行了；
 * - AP-2 等审批卡 → 核对 → 点「拒绝」→ 命令没有执行，模型拿到了拒绝原因；
 * - AP-3 用框架的默认参数等回合（不表态）→ 框架必须按 Esc 拒绝并抛错，命令没有执行。
 * 模型自作主张先调了别的工具时，那张卡不在本用例的放行范围内：AP-1 点「拒绝」并记下，不替用户放行。
 *
 * 「命令执行了没有」以会话落盘里的工具结果为准（ctx.truth 的 tools / timeline / found），不看回复的文字——
 * 被拒绝后模型可能在回复里引用这条命令，那不是命令的输出。
 *
 * 还原纪律：切档前把运行前的档位记进 ctx.state.accessRestore；用例 try/finally 里切回并读回；APX-1
 *（cleanup: true）兜底；运行器在用例超时 / 被中断时还会调块上登记的 restore。读回核对两处：后端的档位值
 *（get_agent_tool_mode）与输入区触发钮的文案，都要等于运行前的值。切回这一步是公共件 restoreAccessMode（kit.mjs）。
 */
import { restoreAccessMode } from "../kit.mjs";
/** 会弹审批的档位，按优先级（文字取自 zh.json；运行器保证界面是中文）。 */
const APPROVE_MODES = ["变更前审批", "智能审批"];
/** 模型不听话、先调了别的工具时最多看几张卡（每张都记下，范围外的一律拒绝）。 */
const MAX_CARDS = 6;

/** 这条命令的编号：回执里只会因为它出现（审批卡上的命令、落盘的工具结果都认它）。 */
const nonceOf = (tag) => `E2E-APPROVAL-${tag}${String(Date.now()).slice(-6)}`;
/**
 * 让模型执行的那条无害命令。编号后面还带一个随机数（bash / PowerShell 都会展开；别的外壳原样打印
 * 也不影响）：输出因此猜不出来，模型不实际执行就答不出「真实输出」。
 * 首跑实跑踩到：固定输出的 echo，快模型两次都没调工具、直接把猜的输出当答案回了（落盘工具调用 0 条）。
 */
const echoOf = (nonce) => `echo ${nonce}-$RANDOM`;

/**
 * 切到会弹审批的档位并读回。返回 { before, label, value, switched }；前提不成立 ctx.skip。
 * 运行前的档位记进 ctx.state.accessRestore——之后无论成败，restoreAccessMode 都会把它调回去。
 */
const enterApproveMode = async (ctx) => {
  const { app } = ctx;
  await app.ensureWorkspace();
  await app.closeGuideCards();
  const access = await app.accessMode();
  if (!access.switchable) ctx.skip(`当前智能体不支持切换访问权限档位（触发钮：${access.label || "找不到"}）——没有会弹审批的档位可用`);
  const before = await app.readToolMode();
  if (before.provider !== "hub_tool_mode") {
    ctx.skip(`当前智能体的权限档位不由 Hub 的工具模式提供（提供方：${before.provider ?? "无"}）——本场景包按 Hub 工具模式的档位编写`);
  }
  const options = await app.accessModeOptions();
  const label = APPROVE_MODES.find((candidate) => options.includes(candidate));
  if (!label) ctx.skip(`当前智能体的权限菜单里没有会弹审批的档位（菜单：${options.join("、") || "读不到"}）`);
  // 菜单项与后端声明的档位值同序：第 i 项就是 modes[i]
  const value = (before.modes ?? [])[options.indexOf(label)] ?? null;
  // 切档会重启该智能体全部会话的引擎进程：有回合在跑就不在这个时候切
  const running = await app.invoke("chat_active_sessions").catch(() => []);
  if (Array.isArray(running) && running.length) {
    ctx.skip(`有 ${running.length} 个会话的回合还在进行——切档会重启引擎进程、打断它们；等它们结束再跑`);
  }
  if (access.label === label) return { before, label, value, switched: false };
  ctx.state.accessRestore = {
    fromLabel: access.label,
    fromMode: before.mode,
    fromEffective: before.effective,
    fromToolApproval: before.toolApproval,
  };
  await app.setAccessMode(label);
  const after = await app.readToolMode();
  const shown = (await app.accessMode()).label;
  if (after.effective !== value || shown !== label) {
    throw new Error(`切到「${label}」没有生效：读回档位 ${JSON.stringify(after.mode)}，触发钮显示「${shown}」`);
  }
  return { before, label, value, switched: true };
};

/** 三条用例共用的起点：新对话、让模型用 bash 执行那条无害命令、确认回合启动。返回 { nonce, command }。 */
const sendEchoTurn = async (ctx, tag) => {
  const { app, page } = ctx;
  const nonce = nonceOf(tag);
  const command = echoOf(nonce);
  await app.newConversation();
  ctx.state.sessionsCreated += 1;
  ctx.since = Date.now();
  await app.send(
    `请用 bash 工具实际执行下面这一条命令，不要推测它的输出。只执行这一条，不要执行别的命令，也不要调用别的工具：\n${command}\n执行完把命令的真实输出原样告诉我，不要解释。`,
  );
  const started = await app.awaitTurnStart(20000);
  if (!started) ctx.skip("模型不可用：消息发出后 20 秒内回合未启动");
  ctx.state.modelOk = true;
  return { nonce, command };
};

/**
 * 没等到写着这条命令的审批卡时分辨原因：命令不经审批就执行了 = 产品缺陷（抛错）；
 * 模型压根没调工具 = 前提不成立（跳过）。
 */
const noCardVerdict = async (ctx, nonce, what) => {
  const truth = await ctx.truth(ctx.since, [nonce]);
  if (truth?.found?.[nonce]?.tool) {
    throw new Error(`${what}：没有弹审批卡，这条命令却执行了（落盘工具结果：${JSON.stringify(truth.tools)}）`);
  }
  ctx.skip(`${what}：模型没有发起这条工具调用（落盘工具结果 ${truth?.tools?.length ?? 0} 条），没法验证审批——前提不成立`);
};

/** 卡上写的是不是本用例指定的那条命令。 */
const isEchoCard = (nonce) => (card) => (card.summary || "").includes(nonce);

export const approvalCases = [
  {
    id: "AP-1",
    name: "审批·同意：点「仅本次允许」后命令真的执行",
    feature: "工具执行审批 / 访问权限档位 / 评审 R2-9（裁决 9：同意与不同意各有自动化）",
    steps: "读当前档位（不假设初始档）→ 有回合在跑就跳过 → 切到「变更前审批」（没有这一档退到「智能审批」）并读回 → 新对话让模型用 bash 执行一条固定输出的 echo → 等审批卡、核对卡上写的就是这条命令 → 截图 → 点「仅本次允许」→ 等回合结束 → 读会话落盘 → finally 切回原档并读回",
    expect: "审批卡出现，卡上的命令就是本用例指定的那条；点的是「仅本次允许」（不点「始终允许」）；落盘里这条命令的执行结果就是那个固定字符串，回复里也有它；终态档位 = 运行前档位（档位读回与触发钮文案都对上）",
    needs: "model",
    timeoutMs: 480000,
    restore: restoreAccessMode,
    run: async (ctx) => {
      const { app } = ctx;
      const mode = await enterApproveMode(ctx);
      try {
        const { nonce, command } = await sendEchoTurn(ctx, "ALLOW");
        const mine = isEchoCard(nonce);
        const decisions = [];
        let target = null;
        for (let i = 0; i < MAX_CARDS && !target; i++) {
          const got = await app.waitApproval(120000);
          if (!got.card) break;
          await ctx.shot(`AP1-审批卡${i + 1}`);
          if (mine(got.card)) {
            target = got.card;
            decisions.push(await app.clickApproval("once", "AP-1"));
          } else {
            decisions.push({ ...(await app.clickApproval("deny", "AP-1")), 范围外: true });
          }
        }
        // 之后框架接手：只放行写着这条命令的卡，别的（模型又调了别的工具）一律拒绝
        const rest = { approvals: "allow", approveOnly: mine };
        const turn = await app.waitTurn({ budgetMs: 180000, ...rest });
        const idle = await app.waitIdle(4000, 180000, rest);
        if (!target) await noCardVerdict(ctx, nonce, "等不到写着这条命令的审批卡");
        if (!turn.done || !idle.idle) throw new Error("点了「仅本次允许」之后，回合没有在时限内结束");
        const truth = await ctx.truth(ctx.since, [nonce]);
        const later = [...turn.approvals.items, ...idle.approvals.items];
        const outside = [...decisions, ...later].filter((d) => d.inScope === false || d.范围外);
        const facts = {
          档位: { 运行前: mode.before.mode, 切到: mode.label, 读回: mode.switched ? mode.label : "（本来就停在这一档）" },
          审批卡: { 工具: target.tool, 命令: target.summary, 卡上的档位: target.mode, 卡上的钮: target.buttons },
          点的钮: decisions.map((d) => d.button),
          范围外被拒绝的调用: outside.map((d) => `${d.tool}: ${d.summary}`),
          落盘工具结果: truth.tools,
          回复里有命令的输出: truth.found[nonce].assistant,
        };
        await ctx.shot("AP1-命令执行之后");
        if (target.mode !== mode.value) throw new Error(`审批卡上的档位是「${target.mode}」，不是刚切到的「${mode.value}」：${JSON.stringify(facts)}`);
        if (decisions.some((d) => d.button !== "仅本次允许" && d.button !== "拒绝")) throw new Error(`点了不该点的钮：${JSON.stringify(decisions)}`);
        if (!truth.tools.some((t) => !t.isError && t.text.includes(nonce))) {
          throw new Error(`点了「仅本次允许」，但落盘里没有这条命令的执行结果：${JSON.stringify(facts)}`);
        }
        if (!truth.found[nonce].assistant) throw new Error(`命令执行了，但回复里没有它的输出：${JSON.stringify(facts)}`);
        return facts;
      } finally {
        await restoreAccessMode(ctx).catch((e) => ctx.warn(`用例收尾时没能切回原档：${e?.message || e}（还原用例 APX-1 会再试）`));
      }
    },
  },
  {
    id: "AP-2",
    name: "审批·不同意：点「拒绝」后命令没有执行",
    feature: "工具执行审批 / 访问权限档位 / 评审 R2-9",
    steps: "读当前档位 → 有回合在跑就跳过 → 切到「变更前审批」并读回 → 新对话让模型用 bash 执行一条固定输出的 echo → 等审批卡、核对卡上写的就是这条命令 → 截图 → 点「拒绝」→ 等回合结束（期间再弹的卡一律拒绝）→ 读会话落盘 → finally 切回原档并读回",
    expect: "审批卡出现，卡上的命令就是本用例指定的那条；点的是「拒绝」；落盘里这条命令的结果是「用户拒绝了此操作」，没有任何工具输出包含那个固定字符串；回复里没有命令的输出（引用命令本身不算）；终态档位 = 运行前档位（档位读回与触发钮文案都对上）",
    needs: "model",
    timeoutMs: 480000,
    restore: restoreAccessMode,
    run: async (ctx) => {
      const { app } = ctx;
      const mode = await enterApproveMode(ctx);
      try {
        const { nonce } = await sendEchoTurn(ctx, "DENY");
        const mine = isEchoCard(nonce);
        const decisions = [];
        let target = null;
        for (let i = 0; i < MAX_CARDS && !target; i++) {
          const got = await app.waitApproval(120000);
          if (!got.card) break;
          await ctx.shot(`AP2-审批卡${i + 1}`);
          const isMine = mine(got.card);
          if (isMine) target = got.card;
          decisions.push({ ...(await app.clickApproval("deny", "AP-2")), 范围外: !isMine });
        }
        // 之后不管模型再调什么工具，一律拒绝
        const turn = await app.waitTurn({ budgetMs: 180000, approvals: "deny" });
        const idle = await app.waitIdle(4000, 180000, { approvals: "deny" });
        if (!target) await noCardVerdict(ctx, nonce, "等不到写着这条命令的审批卡");
        if (!turn.done || !idle.idle) throw new Error("点了「拒绝」之后，回合没有在时限内结束");
        const truth = await ctx.truth(ctx.since, [nonce]);
        const later = [...turn.approvals.items, ...idle.approvals.items];
        // 模型拿到拒绝原因之后给出的回复（调用工具之前先说一句「好的」不算）；引用命令本身（echo …，可带引号）不算输出
        const rejectedAt = truth.timeline.findIndex((row) => row.role === "toolResult" && /拒绝/.test(row.text));
        const replies = rejectedAt >= 0 ? truth.assistantFull.filter((_, k) => truth.assistantAt[k] > rejectedAt) : [];
        const quote = new RegExp(`echo\\s+["'\`]?${nonce}["'\`]?`, "g");
        const leftovers = replies.filter((text) => text.replace(quote, "").includes(nonce));
        const facts = {
          档位: { 运行前: mode.before.mode, 切到: mode.label },
          审批卡: { 工具: target.tool, 命令: target.summary, 卡上的档位: target.mode, 卡上的钮: target.buttons },
          点的钮: [...decisions, ...later].map((d) => d.button),
          落盘工具结果: truth.tools,
          有工具输出包含固定字符串: truth.tools.some((t) => !t.isError && t.text.includes(nonce)),
          拒绝之后模型回复了几段: replies.length,
          回复里残留的输出: leftovers,
          落盘顺序: truth.timeline,
        };
        await ctx.shot("AP2-拒绝之后");
        const allClicks = [...decisions, ...later];
        if (allClicks.some((d) => d.button !== "拒绝")) throw new Error(`「不同意」的用例里点了别的钮：${JSON.stringify(allClicks)}`);
        if (facts.有工具输出包含固定字符串) throw new Error(`点了「拒绝」，这条命令却执行了：${JSON.stringify(facts)}`);
        if (rejectedAt < 0) throw new Error(`点了「拒绝」，落盘里却没有带「用户拒绝了此操作」的工具结果：${JSON.stringify(facts)}`);
        if (!replies.length) throw new Error(`模型拿到拒绝原因之后没有给出回复：${JSON.stringify(truth.timeline)}`);
        if (leftovers.length) throw new Error(`回复里出现了命令的输出（引用命令本身已排除）：${JSON.stringify(leftovers)}`);
        return facts;
      } finally {
        await restoreAccessMode(ctx).catch((e) => ctx.warn(`用例收尾时没能切回原档：${e?.message || e}（还原用例 APX-1 会再试）`));
      }
    },
  },
  {
    id: "AP-3",
    name: "审批·默认不替用户放行：不表态时框架按 Esc 拒绝并报错",
    feature: "测试框架自身（等回合的审批默认值）/ 评审 R2-9",
    steps: "读当前档位 → 有回合在跑就跳过 → 切到「变更前审批」并读回 → 新对话让模型用 bash 执行一条固定输出的 echo → 用默认参数等回合结束（不给 approvals）→ 读会话落盘 → finally 切回原档并读回",
    expect: "默认参数的等待遇到审批卡不点「允许」：按 Esc 拒绝并抛错，报错里写明卡上的工具与命令；落盘里这条命令没有执行；终态档位 = 运行前档位",
    needs: "model",
    timeoutMs: 480000,
    restore: restoreAccessMode,
    run: async (ctx) => {
      const { app } = ctx;
      const mode = await enterApproveMode(ctx);
      try {
        const { nonce } = await sendEchoTurn(ctx, "DEFAULT");
        const logFrom = app.approvalLog.length;
        let error = "";
        try {
          await app.waitTurn({ budgetMs: 180000 });
        } catch (e) {
          error = String(e?.message || e);
        }
        await app.waitIdle(3000, 120000).catch(() => {});
        const truth = await ctx.truth(ctx.since, [nonce]);
        const facts = {
          档位: { 运行前: mode.before.mode, 切到: mode.label },
          默认等待的报错: error,
          框架对审批卡的表态: app.approvalLog.slice(logFrom).map((e) => ({ 谁处理的: e.by, 动作: e.button, 工具: e.tool, 命令: e.summary, 卡收起: e.settled })),
          落盘工具结果: truth.tools,
        };
        await ctx.shot("AP3-默认等待之后");
        if (!error) await noCardVerdict(ctx, nonce, "默认参数等回合时没有弹审批卡、也没有报错");
        if (!/出现了 \d+ 张审批卡/.test(error) || !/按 Esc 拒绝/.test(error)) {
          throw new Error(`默认等待报的错不是「出现审批卡、已按 Esc 拒绝」：${error}`);
        }
        if (truth.tools.some((t) => !t.isError && t.text.includes(nonce))) {
          throw new Error(`框架默认放行了审批——这条命令被执行了：${JSON.stringify(facts)}`);
        }
        // 模型自作主张先调了别的工具：被拒绝的是那张卡，不是这条命令的——前提不成立，跳过并写明
        if (!app.approvalLog.slice(logFrom).some((e) => e.by === "waitTurn" && e.summary?.includes(nonce))) {
          ctx.skip(`默认等待拒绝的是别的工具的审批卡（${JSON.stringify(facts.框架对审批卡的表态)}），模型没有对这条命令发起调用——没法验证「这条命令被拒绝」`);
        }
        if (!error.includes(nonce)) throw new Error(`默认等待的报错里没有写明卡上的命令（应含 ${nonce}）：${error}`);
        return facts;
      } finally {
        await restoreAccessMode(ctx).catch((e) => ctx.warn(`用例收尾时没能切回原档：${e?.message || e}（还原用例 APX-1 会再试）`));
      }
    },
  },
  {
    id: "APX-1",
    name: "还原：把访问权限档位调回运行前的那一档",
    feature: "副作用还原（访问权限档位）",
    steps: "若有用例切过档位：先停掉残留回合 → 读当前触发钮文案 → 不是原档就点权限菜单切回 → 读回档位与触发钮文案",
    expect: "档位读回 = 运行前档位，触发钮文案 = 运行前的文案；没切过档位时如实返回「不需要还原」",
    needs: "none",
    timeoutMs: 180000,
    cleanup: true,
    run: async (ctx) => {
      if (!ctx.state.accessRestore) ctx.skip("本轮没有切过访问权限档位，不需要还原");
      return restoreAccessMode(ctx);
    },
  },
];
