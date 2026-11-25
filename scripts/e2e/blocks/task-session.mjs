/**
 * 积木：v0.9.8 需求24 续——任务会话与普通会话统一成一套（TS-1~TS-4）。
 * 对应需求文档 docs/v0.9.8/需求24-任务会话绿点点击后无法消除/（tests/06-测试清单 第三节）。
 *
 * 打开任何会话（普通会话、任务主会话、任务图里节点的子会话）都走同一个打开函数之后，
 * 任务会话在「显示什么、停在哪」上应该和普通会话完全一样：
 * - TS-1 在底部离开 → 回来还在底部
 * - TS-2 往上翻一段 → 切走 → 回来停在刚才的位置
 * - TS-3 在底部离开 → 后台来了新回复 → 回来停在最底部（新回复看得到）
 * - TS-4 切节点：主区换成节点的子会话，回到主会话
 *
 * TS-1~TS-3 需要一个消息比视口高的任务会话（内容不比视口高，停在哪都一样，量不出来）。
 * 项目里没有这样的任务时，TS-1 会往第一个任务会话里发一条长回复请求把它变长。
 * TS-4 自己造一个带任务图的任务（两个节点，执行时各跑出一个子会话；第二个的回复比视口高），留在项目里。
 * 四条都要模型。测试发的消息、建的任务都不删。
 *
 * 落到哪个会话靠内容判断，不靠会话头的短号：相近时间建的会话前 8 位会重复。
 * 「切走」一律点一个普通会话行：点「新对话」离开不记滚动位置（普通会话也是这样）。
 */
import { expect } from "../lib-pw.mjs";

const SLOW_MESSAGE = "不要调用任何工具。请从 1 数到 600，每行一个数字，只输出数字。";
/** 留作任务主会话的一条最短消息。 */
const MAIN_MESSAGE = "不要调用任何工具。只回复两个字：收到。";
/** 带任务图的任务里的两个节点：第二个的回复比视口高。 */
const GRAPH_NODES = [
  { nodeId: "node-reply", title: "只回复完成", prompt: "不要调用任何工具。只回复两个字：完成。" },
  { nodeId: "node-count", title: "数到 1500", prompt: "不要调用任何工具。请从 1 数到 1500，每行一个数字，只输出数字。" },
];

const stopBtn = (page) => page.locator('button[title="停止"]:not([disabled])').first();
const messageRows = (page) => page.locator('[data-turn-scope="main"] [data-message-index]');
const regularRows = (app) => app.sidebar().locator("button.flex-col.items-start").filter({ has: app.page.locator("span.truncate[title]") });

/** 消息区的滚动位置（主区里可滚动的那个容器）；还没渲染出来返回 null。 */
const viewState = (page) =>
  page.evaluate(() => {
    const main = document.querySelector('[data-turn-scope="main"]');
    let el = main;
    while (el && el !== document.body) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) break;
      el = el.parentElement;
    }
    if (!main || !el || el === document.body) return null;
    return {
      scrollTop: Math.round(el.scrollTop),
      clientHeight: Math.round(el.clientHeight),
      scrollHeight: Math.round(el.scrollHeight),
      atBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) <= 2,
    };
  });

/**
 * 打开任务行，并等它的消息真正渲染出来。
 * 会话头先变、消息后到——只看会话头就去量滚动位置，读到的会是上一个会话的内容。
 */
const openTaskAndWait = async (ctx, row, task) => {
  const { page } = ctx;
  await ctx.app.openTaskRow(row, task);
  await expect(messageRows(page).first()).toBeVisible({ timeout: 15000 });
};

/** 等消息渲染出来、滚动位置连续 700 毫秒不变再读（定位、贴底跟随都要时间）。 */
const settleView = async (ctx, timeout = 15000) => {
  const { page } = ctx;
  const deadline = Date.now() + timeout;
  let last = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const view = await viewState(page);
    if (view && last && view.scrollTop === last.scrollTop && view.scrollHeight === last.scrollHeight) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 700) return view;
    } else {
      stableSince = 0;
    }
    last = view;
    await page.waitForTimeout(150);
  }
  return last;
};

/** 用真实滚轮把消息区滚到底（悬停在消息区上）。 */
const wheelToBottom = async (ctx) => {
  const { page } = ctx;
  await page.locator('[data-turn-scope="main"]').first().hover({ position: { x: 160, y: 160 } });
  for (let i = 0; i < 6; i++) {
    const view = await viewState(page);
    if (view?.atBottom) return view;
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(250);
  }
  return viewState(page);
};

/**
 * 打开一个消息比视口高的任务会话。项目里没有就往第一个任务会话里发一条长回复请求。
 * 返回 { task, row, view }；造不出来返回 null（调用方标跳过）。
 */
const openTallTask = async (ctx) => {
  const { app, page } = ctx;
  const records = (await app.taskRecords()).filter((r) => r.task_session_id);
  if (!records.length) return null;
  const rowOf = (task) => app.taskRows().filter({ hasText: task.title }).first();
  const isTall = (view) => Boolean(view && view.scrollHeight > view.clientHeight + 80 && (view.rows ?? 1) > 0);
  for (const task of records.slice(0, 3)) {
    await openTaskAndWait(ctx, rowOf(task), task);
    const view = await settleView(ctx);
    if (isTall(view) && (await messageRows(page).count()) > 0) return { task, row: rowOf(task), view };
  }
  // 都不够长：把第一个任务会话变长
  const task = records[0];
  const row = rowOf(task);
  await openTaskAndWait(ctx, row, task);
  await app.send(SLOW_MESSAGE);
  const started = await stopBtn(page).waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false);
  if (!started) return null;
  const turn = await app.waitTurn({ budgetMs: 180000, settleMs: 4000 });
  await app.waitIdle(3000, 120000);
  if (!turn.done) return null;
  const view = await settleView(ctx);
  return isTall(view) && (await messageRows(page).count()) > 0 ? { task, row, view } : null;
};

/** 点一个普通会话行切走（这样离开时会记滚动位置），并校验确实离开了任务会话。 */
const leaveToRegularSession = async (ctx, task) => {
  const { app } = ctx;
  const others = regularRows(app);
  if (!(await others.count())) return false;
  await others.first().click();
  // 落点校验：会话头不再是任务的那个会话
  await expect
    .poll(
      async () => {
        const head = await app.sessionHeader();
        return Boolean(head?.id) && !task.task_session_id.startsWith(head.id);
      },
      { timeout: 10000 },
    )
    .toBe(true);
  return true;
};

// 收尾：回到新对话页——用例中途失败时不把任务工作台留给下一块
const withCleanup = (c) => ({
  ...c,
  run: async (ctx) => {
    try {
      return await c.run(ctx);
    } finally {
      await ctx.app.newConversation().catch(() => {});
    }
  },
});

export const taskSessionCases = [
  {
    id: "TS-1",
    name: "任务会话：在底部离开，回来还在底部",
    feature: "任务会话 / 滚动位置 / 需求24 续",
    steps: "打开一个内容比视口高的任务会话 → 滚到底 → 点一个普通会话切走 → 再点任务行",
    expect: "回来后视图在最底部",
    needs: "model",
    timeoutMs: 420000,
    run: async (ctx) => {
      const { app } = ctx;
      await app.ensureWorkspace();
      await app.closeGuideCards();
      const opened = await openTallTask(ctx);
      if (!opened) ctx.skip("当前项目没有内容比视口高的任务会话（也造不出来），量不出停在哪");
      const { task, row } = opened;
      const before = await wheelToBottom(ctx);
      if (!before?.atBottom) ctx.skip("滚不到底部，前提不成立");
      if (!(await leaveToRegularSession(ctx, task))) ctx.skip("项目里没有别的会话可以切过去");
      await openTaskAndWait(ctx, row, task);
      const after = await settleView(ctx);
      if (!after?.atBottom) throw new Error(`在底部离开再回来，没有停在最底部：${JSON.stringify(after)}`);
      await ctx.shot("TS1-回来在底部");
      return { 任务: task.title.slice(0, 24), 离开时: before, 回来后: after };
    },
  },
  {
    id: "TS-2",
    name: "任务会话：往上翻一段，切走再回来停在刚才的位置",
    feature: "任务会话 / 滚动位置 / 需求24 续",
    steps: "打开一个内容比视口高的任务会话 → 用滚轮往上翻 → 记下位置 → 点一个普通会话切走 → 再点任务行",
    expect: "回来后的滚动位置与离开时一致（±2 像素）",
    needs: "model",
    timeoutMs: 420000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.ensureWorkspace();
      await app.closeGuideCards();
      const opened = await openTallTask(ctx);
      if (!opened) ctx.skip("当前项目没有内容比视口高的任务会话（也造不出来），量不出位置");
      const { task, row } = opened;
      await page.locator('[data-turn-scope="main"]').first().hover({ position: { x: 160, y: 160 } });
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(400);
      const before = await settleView(ctx);
      if (!before || before.atBottom || before.scrollTop <= 0) ctx.skip(`没能翻离底部（${JSON.stringify(before)}），前提不成立`);
      if (!(await leaveToRegularSession(ctx, task))) ctx.skip("项目里没有别的会话可以切过去");
      await openTaskAndWait(ctx, row, task);
      const after = await settleView(ctx);
      if (Math.abs(after.scrollTop - before.scrollTop) > 2) {
        throw new Error(`离开时停在 ${before.scrollTop}，回来停在 ${after.scrollTop}`);
      }
      await ctx.shot("TS2-回来停在原处");
      return { 任务: task.title.slice(0, 24), 离开时: before.scrollTop, 回来后: after.scrollTop };
    },
  },
  {
    id: "TS-3",
    name: "任务会话：在底部离开，后台来了新回复，回来停在最底部",
    feature: "任务会话 / 滚动位置 / 后台回合 / 需求24 续",
    steps: "打开一个内容比视口高的任务会话 → 发一条长回复请求 → 回合结束前点一个普通会话切走 → 等任务行出现绿点 → 再点任务行",
    expect: "回来后视图在最底部，新回复的最后内容在屏幕上（修前停在离开时的老位置，看不到新回复）",
    needs: "model",
    timeoutMs: 420000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.ensureWorkspace();
      await app.closeGuideCards();
      const opened = await openTallTask(ctx);
      if (!opened) ctx.skip("当前项目没有内容比视口高的任务会话（也造不出来），量不出停在哪");
      const { task, row } = opened;
      await wheelToBottom(ctx);
      await app.send(SLOW_MESSAGE);
      const started = await stopBtn(page).waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false);
      if (!started) ctx.skip("模型不可用：消息发出后 20 秒内回合未启动");
      const leaving = await viewState(page);
      if (!(await leaveToRegularSession(ctx, task))) ctx.skip("项目里没有别的会话可以切过去");
      if (!leaving?.atBottom) ctx.skip(`切走那一刻视图不在底部（${JSON.stringify(leaving)}），前提不成立`);
      const state = await app.waitRowState(row, ["done", "failed"], 180000);
      if (state !== "done" && state !== "failed") ctx.skip(`后台回合没有留下未读（行状态 ${state}）`);
      await openTaskAndWait(ctx, row, task);
      const after = await settleView(ctx);
      if (!after?.atBottom) throw new Error(`在底部离开、后台来了新回复，回来没有停在最底部：${JSON.stringify(after)}`);
      const tail = (await page.locator('[data-turn-scope="main"]').textContent())?.trim().slice(-16) ?? "";
      // 消息后面跟着「复制」按钮的字样；新回复的最后两行是 599、600
      if (!/599\s*600(\s*复制)?\s*$/.test(tail.replace(/\s+/g, " "))) {
        throw new Error(`视图在底部，但新回复的最后一段不在页面末尾：「${tail}」`);
      }
      await ctx.shot("TS3-回来停在新回复处");
      return { 任务: task.title.slice(0, 24), 离开时: leaving, 后台回合留下的: state, 回来后: after, 页面末尾: tail };
    },
  },
  {
    id: "TS-4",
    name: "切节点：主区换成节点的会话，取消后回到任务主会话",
    feature: "任务工作台 / 节点会话 / 需求24 续",
    steps: "新对话发一条最短的消息（留作任务的主会话）→ 造一个带任务图的任务（两个节点：只回复完成 / 数到 1500），等两个节点都执行完 → 把主会话挂到任务上 → 点任务行 → 点执行卡里的「只回复完成」→ 打开任务看板点「数到 1500」→ 点「主会话」",
    expect: "每一步主区显示的都是对应会话的内容：主会话 → 节点一的会话 → 节点二的会话（视图在最底部）→ 主会话；一进任务任务看板就列出两个节点和「主会话」入口（任务图加载完就看板跟着刷新）",
    needs: "model",
    timeoutMs: 480000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.ensureWorkspace();
      await app.closeGuideCards();
      const mainArea = page.locator('[data-turn-scope="main"]');
      const nodeReply = /只回复两个字：完成/;
      const nodeCount = /1499\s+1500/;

      // 主会话：新对话发一条最短的消息
      await app.newConversation();
      await app.send(MAIN_MESSAGE);
      const started = await stopBtn(page).waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false);
      if (!started) ctx.skip("模型不可用：主会话的消息发出后 20 秒内回合未启动");
      const turn = await app.waitTurn({ budgetMs: 120000, settleMs: 3000 });
      if (!turn.done) throw new Error("主会话的回合没有在时限内结束");
      await app.waitIdle(2000, 60000);
      const short = (await app.sessionHeader())?.id;
      if (!short) throw new Error("读不到主会话的会话头");

      // 带任务图的任务：两个节点各自跑出一个子会话
      const title = `节点会话验证${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}`;
      const made = await app.createGraphTask({ title, nodes: GRAPH_NODES });
      const mainId = await app.sessionFullId(short, made.encodedName);
      if (!mainId) throw new Error("找不到主会话的完整 id");
      await app.attachTaskMainSession({ taskId: made.taskId, sessionId: mainId, title });
      const nodeRuns = await app.waitGraphRun(made.runId);
      const missing = nodeRuns.filter((n) => n.status !== "succeeded" || !n.sessionId);
      if (missing.length) ctx.skip(`有节点没有跑出子会话：${JSON.stringify(nodeRuns)}`);

      // 打开任务：显示的是主会话
      const row = app.taskRows().filter({ hasText: title }).first();
      await expect(row).toBeVisible({ timeout: 12000 });
      await app.newConversation();
      await row.click();
      await expect(mainArea).toContainText("只回复两个字：收到", { timeout: 15000 });
      // 任务图加载完，看板要跟着从「没有图」刷新成两个节点（修前停在 0/0，直到面板重新挂载）
      const board = page.locator('[data-panel-id="session.task-board"]');
      await expect(board).toContainText("2/2", { timeout: 15000 });
      await expect(board.locator('button[title="本任务的需求/规划/执行讨论会话"]')).toBeVisible();

      // 相近时间建的会话短号会重复——落到哪个会话只能靠内容判断
      await page.getByText("只回复完成", { exact: true }).first().click();
      await expect(mainArea).toContainText(nodeReply, { timeout: 15000 });
      await expect(mainArea).not.toContainText("只回复两个字：收到");
      await ctx.shot("TS4-节点一的会话");

      // 选中节点后执行卡不在了：换节点走任务看板
      if (!(await board.count())) {
        await page.getByRole("button", { name: "任务看板", exact: true }).first().click();
        await board.waitFor({ state: "visible", timeout: 8000 });
      }
      await board.getByText("数到 1500", { exact: true }).first().click();
      await expect(mainArea).toContainText(nodeCount, { timeout: 15000 });
      await expect(mainArea).not.toContainText(nodeReply);
      const view = await settleView(ctx);
      if (!(view && view.scrollHeight > view.clientHeight + 80)) ctx.skip(`节点二的回复不够长（${JSON.stringify(view)}），量不出停在哪`);
      if (!view.atBottom) throw new Error(`节点二的会话内容比视口高，打开后没有停在最底部：${JSON.stringify(view)}`);
      await ctx.shot("TS4-节点二的会话");

      // 回到任务主会话
      if (!(await board.count())) {
        await page.getByRole("button", { name: "任务看板", exact: true }).first().click();
        await board.waitFor({ state: "visible", timeout: 8000 });
      }
      await board.locator('button[title="本任务的需求/规划/执行讨论会话"]').click();
      await expect(mainArea).toContainText("只回复两个字：收到", { timeout: 15000 });
      await expect(mainArea).not.toContainText(nodeCount);
      await ctx.shot("TS4-回到主会话");
      return {
        任务: title,
        节点: nodeRuns.map((n) => ({ 节点: n.nodeId, 状态: n.status, 有子会话: Boolean(n.sessionId) })),
        节点二会话的视图: view,
      };
    },
  },
].map(withCleanup);
