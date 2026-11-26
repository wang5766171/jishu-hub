/**
 * 积木：v0.9.8 需求24 续——任务会话与普通会话统一成一套（TS-1~TS-4）；评审修复轮 R2 补 TS-5、TS-6，
 * 并按裁决 5 改掉 TS-1、TS-3 的前提。用例清单：docs/v0.9.8/评审修复轮-R2/tests/E-用例清单.md。
 *
 * 打开任何会话（普通会话、任务主会话、任务图里节点的子会话）都走同一个打开函数之后，
 * 任务会话在「显示什么、停在哪」上应该和普通会话完全一样：
 * - TS-1 打开就停在底部；在底部离开 → 回来还在底部
 * - TS-2 往上翻一段 → 切走 → 回来停在刚才的位置
 * - TS-3 重开后打开在底部；在底部离开 → 后台来了新回复 → 回来停在最底部（新回复看得到）
 * - TS-4 切节点：主区换成节点的子会话，回到主会话
 * - TS-5 读磁盘期间切走的会话，晚到的结果不留痕迹（让一次读盘变慢来复现；回归用例）
 * - TS-6 从往上翻着的会话切到别的会话：不空白、落在最底部（回归用例）
 *
 * 「首次打开」怎么造（裁决 5：打开软件进入会话 → 最底部；离开再回来 → 离开的位置；关闭软件记忆清除）：
 * 滚动记忆、访问记录、消息缓存都只活在页面内存里，所以**重载页面**之后的第一次打开，与「启动后第一次
 * 进入」「关闭软件重开后再进入」是同一种状态——前端内存清零（引擎进程不重启）。TS-1、TS-3 用重载来造，
 * 不依赖应用是什么时候启动的、之前打开过哪些会话。
 *
 * TS-1~TS-3 需要一个消息比视口高的任务会话（内容不比视口高，停在哪都一样，量不出来）。优先用项目里
 * 现成的任务；都不够长就往第一个任务会话里发一条长回复请求把它变长；项目里一个任务都没有时自己造一个
 *（主会话直接要一条长回复，图上的节点不调用工具）。三块用同一个任务会话——TS-3「重开后不回到重载前
 * 离开的位置」因此成立。TS-4 自己造一个带任务图的任务（两个节点，执行时各跑出一个子会话；第二个的回复
 * 比视口高），留在项目里。测试发的消息、建的任务都不删。
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
/** 造「够长的任务会话」时图上的那一个节点：不调用工具。 */
const TALL_TASK_NODE = GRAPH_NODES[0];
/** 任务标题里的时间戳（标题不要带「任务会话」四个字——驱动库按它找任务分组，会把这个任务的行漏掉）。 */
const stamp = () => new Date().toTimeString().slice(0, 8).replace(/:/g, "");
const messageRows = (page) => page.locator('[data-turn-scope="main"] [data-message-index]');
const regularRows = (app) => app.sidebar().locator("button.flex-col.items-start").filter({ has: app.page.locator("span.truncate[title]") });
// 按任务号找（行上带 data-task-id）。标题会重复——项目里好几个任务都叫「新任务」时，按标题找
// 会点开别的任务（首跑实跑踩到：点「新任务」落到了另一个任务的会话上）。
const taskRowOf = (app, task) => app.sidebar().locator(`button[data-task-id="${task.task_id}"]`).first();

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

/** 「任务会话」分组收起时把它展开（分组里应该有任务行却一条都没有时才点——点一下是开合切换）。 */
const ensureTaskRows = async (ctx) => {
  const { app } = ctx;
  if (await app.taskRows().count()) return;
  if (!((await app.taskRecords()).some((r) => r.task_session_id))) return;
  const head = app.sidebar().getByRole("button", { name: /^任务会话/ }).first();
  if (await head.isVisible().catch(() => false)) await head.click();
  await app.taskRows().first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
};

/**
 * 重载应用页面：滚动记忆、访问记录、消息缓存清零 = 「启动后第一次进入」/「关闭软件重开」的状态
 *（见文件头）。重载后核对项目没变、会话列表或任务列表加载出来。返回 { reloaded, reason? }。
 * 有会话的回合还在跑时不重载（前端会丢掉对流式的跟踪）——调用方标跳过。
 */
const reloadFresh = async (ctx) => {
  const { app, page } = ctx;
  const project = ctx.cfg.project;
  const active = await app.invoke("chat_active_sessions").catch(() => []);
  if (Array.isArray(active) && active.length) {
    return { reloaded: false, reason: `有 ${active.length} 个会话的回合还在进行——重载页面会让前端丢掉对流式的跟踪，等它们结束再跑` };
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  const back = page.getByRole("button", { name: "返回工作区", exact: true });
  await expect(app.composer().or(back).first()).toBeVisible({ timeout: 30000 });
  if (await back.isVisible().catch(() => false)) await back.click();
  await expect(app.composer()).toBeVisible({ timeout: 15000 });
  await app.closeGuideCards();
  // 界面落定：项目名出来了、会话列表或任务列表出来了（刚重载完的几秒里界面还没就绪）
  await expect
    .poll(async () => Boolean(await app.currentProjectName()) || Boolean(await app.sidebarProjectName()), { timeout: 30000 })
    .toBe(true);
  await expect(app.sidebar().locator("button.flex-col.items-start").or(app.taskRows().first()).first()).toBeVisible({ timeout: 30000 });
  await app.sleep(1500);
  await app.ensureWorkspace(project);
  await ensureTaskRows(ctx);
  const now = await app.currentProjectName();
  if (project && now !== project) throw new Error(`重载后项目变了：运行前「${project}」，现在「${now}」`);
  return { reloaded: true };
};

/**
 * 一个消息比视口高的任务会话（TS-1~TS-3 共用）。依次：项目里现成的任务（逐个打开看内容够不够长）→
 * 都不够长就往第一个任务会话里发一条长回复请求把它变长 → 项目里一个任务都没有时自己造一个
 *（主会话直接要一条长回复；图上的节点不调用工具）。造不出来返回 null（调用方标跳过）。
 * 上一块认下的那个任务排最前——三块因此用的是同一个任务会话。
 */
const ensureTallTask = async (ctx) => {
  const { app, page } = ctx;
  const isTall = (view) => Boolean(view && view.scrollHeight > view.clientHeight + 80);
  let records = (await app.taskRecords()).filter((r) => r.task_session_id);
  if (!records.length) {
    let made;
    try {
      made = await app.createTaskWithMainSession({ title: `滚动验证${stamp()}`, nodes: [TALL_TASK_NODE], mainMessage: SLOW_MESSAGE });
    } catch (e) {
      if (/^模型不可用/.test(String(e?.message || e))) ctx.skip(e.message);
      throw e;
    }
    ctx.state.tallTaskTitle = made.title;
    records = (await app.taskRecords()).filter((r) => r.task_session_id);
  }
  const known = ctx.state.tallTaskTitle;
  records = [...records].sort((a, b) => Number(b.title === known) - Number(a.title === known));
  if (!records.length) return null;
  const tallEnough = async (view) => isTall(view) && (await messageRows(page).count()) > 0;
  for (const task of records.slice(0, 3)) {
    await openTaskAndWait(ctx, taskRowOf(app, task), task);
    const view = await settleView(ctx);
    if (await tallEnough(view)) {
      ctx.state.tallTaskTitle = task.title;
      return { task, view };
    }
  }
  // 都不够长：把第一个任务会话变长（提示词写明不调用工具——等回合用框架默认值即可，不表态）
  const task = records[0];
  await openTaskAndWait(ctx, taskRowOf(app, task), task);
  await app.send(SLOW_MESSAGE);
  const started = await app.awaitTurnStart(20000);
  if (!started) return null;
  const turn = await app.waitTurn({ budgetMs: 180000, settleMs: 4000 });
  await app.waitIdle(3000, 120000);
  if (!turn.done) return null;
  const view = await settleView(ctx);
  if (!(await tallEnough(view))) return null;
  ctx.state.tallTaskTitle = task.title;
  return { task, view };
};

/**
 * 打开一个会话，量它「第一个可见帧」停在哪——按帧量。点击前把页面的 requestAnimationFrame 换成
 * 「每个帧回调跑完之后再采样一次」的版本：同一帧里最后一次采到的，就是这一帧上屏时的样子。
 * 被遮住的不算可见；第一个「没被遮住、显示的已是新会话的内容」的帧就是它的第一个可见帧
 *（修前表现：先空白约 0.8 秒，然后落在顶部）。
 * 不用定时采样：拉底是在帧回调里做的、先于绘制。两次绘制之间的定时采样会读到「遮蔽已解除、
 * 内容刚长高、还没拉底」的状态——它从没上过屏（首跑实跑踩到：定时采样报「离底 65 像素」，
 * 同一个会话按帧量四轮，首个可见帧都在底部）。
 * 顺便记下：选中态切过去之后，还有几帧在显示上一个会话的内容——读盘期间不该放旧内容；
 * 这里只记事实，由调用方决定告警还是判失败。
 */
const openAndMeasureFirstFrame = async (ctx, open) => {
  const { page } = ctx;
  await page.evaluate(() => {
    const real = window.requestAnimationFrame.bind(window);
    const headerText = () => {
      const el = [...document.querySelectorAll("span.font-mono")].find((e) => {
        const r = e.getBoundingClientRect();
        return r.top >= 0 && r.top < 90 && r.left > 230;
      });
      return el ? (el.textContent || "").trim() : "";
    };
    const contentSig = (main) => {
      const rows = main ? main.querySelectorAll("[data-message-index]") : [];
      return `${rows.length}|${rows[0]?.textContent?.slice(0, 40) ?? ""}`;
    };
    const find = () => {
      const main = document.querySelector('[data-turn-scope="main"]');
      let scroller = main;
      while (scroller && scroller !== document.body) {
        if (/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) break;
        scroller = scroller.parentElement;
      }
      return main && scroller && scroller !== document.body ? { main, scroller } : null;
    };
    const s = (window.__ts1 = {
      t0: performance.now(),
      real,
      stopped: false,
      frames: 0,
      masked: 0,
      firstVisibleAt: null,
      firstFrame: null,
      prevSig: contentSig(document.querySelector('[data-turn-scope="main"]')),
      prevHead: headerText(),
      headChangedAt: null,
      oldContentAfterSwitch: 0,
    });
    // hidden：被遮住（或消息区还没渲染出来）；empty：可见但没有消息行（读盘期间、保险到点后的空列表）；
    // old：显示的还是上一个会话的内容；new：新会话的内容
    const read = () => {
      const hit = find();
      if (!hit) return { kind: "hidden" };
      const hidden =
        getComputedStyle(hit.scroller).visibility === "hidden" ||
        [...hit.main.querySelectorAll('[style*="visibility: hidden"]')].some((node) => node.style?.visibility === "hidden");
      if (hidden) return { kind: "hidden" };
      if (!hit.main.querySelectorAll("[data-message-index]").length) return { kind: "empty" };
      if (contentSig(hit.main) === s.prevSig) return { kind: "old" };
      return {
        kind: "new",
        top: Math.round(hit.scroller.scrollTop),
        gap: Math.round(hit.scroller.scrollHeight - hit.scroller.scrollTop - hit.scroller.clientHeight),
      };
    };
    // 一帧结束（下一帧开始、或停止采样）时结算它：本帧最后一次采样就是它上屏的样子
    let pending = null;
    const settleFrame = () => {
      const state = pending?.state;
      pending = null;
      if (!state) return;
      s.frames += 1;
      if (state.kind === "hidden") {
        s.masked += 1;
        return;
      }
      if (state.kind === "empty") return;
      if (state.kind === "old") {
        const head = headerText();
        if (s.headChangedAt === null && head && head !== s.prevHead) s.headChangedAt = Math.round(performance.now() - s.t0);
        if (s.headChangedAt !== null) s.oldContentAfterSwitch += 1;
        return;
      }
      if (s.firstVisibleAt === null) {
        s.firstVisibleAt = Math.round(performance.now() - s.t0);
        s.firstFrame = { 滚动位置: state.top, 离底像素: state.gap };
      }
    };
    const sample = (now) => {
      const key = Math.round(now);
      if (!pending || pending.key !== key) {
        settleFrame();
        pending = { key, state: null };
      }
      pending.state = read();
    };
    window.__ts1Settle = () => {
      settleFrame();
      window.requestAnimationFrame = real;
      s.stopped = true;
    };
    window.requestAnimationFrame = (cb) => real((t) => {
      cb(t);
      sample(t);
    });
    // 没有别的帧回调时（读盘期间被遮着）也保证每帧采样一次
    const tick = () => {
      if (!s.stopped) window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });
  try {
    await open();
    await expect(messageRows(page).first()).toBeVisible({ timeout: 15000 });
    await settleView(ctx);
  } finally {
    await page.evaluate(() => window.__ts1Settle?.()).catch(() => {});
  }
  return page.evaluate(() => {
    const { real, stopped, prevSig, prevHead, ...rest } = window.__ts1;
    return rest;
  });
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
    name: "任务会话：打开就停在底部；在底部离开，回来还在底部",
    feature: "任务会话 / 滚动位置 / 评审修复轮 R2（裁决 5：打开软件进入会话，进入最底部）",
    steps: "准备一个内容比视口高的任务会话 → 重载页面（前端的滚动记忆、访问记录、消息缓存清零，等同「启动后第一次进入」）→ 先点开一个普通会话 → 点任务行，从点击起按帧记录（每帧的帧回调都跑完之后读一次），量它第一个可见帧停在哪 → 点一个普通会话切走 → 再点任务行",
    expect: "第一个可见帧就在最底部（不空白后落在顶部——修前表现）；内容渲染完仍在底部；在底部离开再回来还在底部",
    needs: "model",
    timeoutMs: 480000,
    run: async (ctx) => {
      const { app } = ctx;
      await app.ensureWorkspace();
      await app.closeGuideCards();
      // 先准备一个内容比视口高的任务会话（可能要发一条长回复——这一步在重载之前）
      const fx = await ensureTallTask(ctx);
      if (!fx) ctx.skip("当前项目没有内容比视口高的任务会话（也造不出来），量不出停在哪");
      const { task } = fx;
      // 重载前先离开任务会话（停到新对话页）：重载后点它，才是这个任务会话在「这次开启」里的第一次打开
      await app.newConversation();
      const fresh = await reloadFresh(ctx);
      if (!fresh.reloaded) ctx.skip(fresh.reason);
      // 先打开一个普通会话，再从它切到任务会话（和真人使用一样；顺便量「读盘期间有没有露出上一个会话的内容」）
      if (await regularRows(app).count()) {
        await regularRows(app).first().click();
        await app.sleep(800);
      }
      // 首次打开：不再先手动滚到底——直接量它一打开停在哪（修前要先滚到底，才量得出「回来在底部」）
      const row = taskRowOf(app, task);
      await row.waitFor({ state: "visible", timeout: 15000 });
      const first = await openAndMeasureFirstFrame(ctx, () => app.openTaskRow(row, task));
      const opened = await settleView(ctx);
      await ctx.shot("TS1-首次打开");
      const facts = {
        任务: task.title.slice(0, 24),
        第一个可见帧于毫秒: first.firstVisibleAt,
        第一个可见帧: first.firstFrame,
        定位期间被遮住的帧数: first.masked,
        选中之后仍显示上一个会话内容的帧数: first.oldContentAfterSwitch,
        渲染完之后: opened,
      };
      if (!(opened && opened.scrollHeight > opened.clientHeight + 80)) ctx.skip(`这个任务会话的内容不够长（${JSON.stringify(opened)}），量不出停在哪`);
      if (!first.firstFrame) throw new Error(`没量到第一个可见帧（共 ${first.frames} 帧，其中被遮住 ${first.masked} 帧）：${JSON.stringify(facts)}`);
      if (first.firstFrame.离底像素 > 2) {
        throw new Error(
          `任务会话首次打开，第一个可见帧不在底部（滚动位置 ${first.firstFrame.滚动位置}，离底 ${first.firstFrame.离底像素} 像素）——修前表现是先空白再落在顶部：${JSON.stringify(facts)}`,
        );
      }
      if (!opened.atBottom) throw new Error(`任务会话首次打开，渲染完之后没有停在最底部：${JSON.stringify(facts)}`);
      // 读盘期间露出上一个会话的内容：O 域单测（O1-U3）锁定的行为，这里只告警、不判失败
      if (first.oldContentAfterSwitch > 0) {
        ctx.warn(`切到任务会话之后有 ${first.oldContentAfterSwitch} 帧仍显示上一个会话的内容（读盘期间不该放旧内容，O 域单测 O1-U3 的口径）`);
      }
      // 在底部离开 → 回来
      if (!(await leaveToRegularSession(ctx, task))) {
        ctx.warn("项目里没有别的会话可以切过去，「在底部离开再回来还在底部」这一段没有验证");
        return facts;
      }
      await openTaskAndWait(ctx, row, task);
      const after = await settleView(ctx);
      if (!after?.atBottom) throw new Error(`在底部离开再回来，没有停在最底部：${JSON.stringify({ ...facts, 回来后: after })}`);
      await ctx.shot("TS1-回来在底部");
      return { ...facts, 回来后: after };
    },
  },
  {
    id: "TS-2",
    name: "任务会话：往上翻一段，切走再回来停在刚才的位置",
    feature: "任务会话 / 滚动位置 / 需求24 续",
    steps: "打开一个内容比视口高的任务会话 → 用滚轮往上翻 → 记下位置 → 点一个普通会话切走 → 再点任务行",
    expect: "回来后的滚动位置与离开时一致（±2 像素）",
    needs: "model",
    timeoutMs: 480000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.ensureWorkspace();
      await app.closeGuideCards();
      const opened = await ensureTallTask(ctx);
      if (!opened) ctx.skip("当前项目没有内容比视口高的任务会话（也造不出来），量不出位置");
      const { task } = opened;
      await page.locator('[data-turn-scope="main"]').first().hover({ position: { x: 160, y: 160 } });
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(400);
      const before = await settleView(ctx);
      // 修前：首次打开落在顶部，往上翻不动，这里只能跳过——首次打开就在底部之后，这一段才量得出来
      if (!before || before.atBottom || before.scrollTop <= 0) ctx.skip(`没能翻离底部（${JSON.stringify(before)}），前提不成立`);
      if (!(await leaveToRegularSession(ctx, task))) ctx.skip("项目里没有别的会话可以切过去");
      ctx.state.tallTaskLeftMid = true; // TS-3 靠它：重载前这个任务会话是「翻着离开」的
      await openTaskAndWait(ctx, taskRowOf(app, task), task);
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
    name: "任务会话：重开后打开在底部；在底部离开，后台来了新回复，回来停在最底部",
    feature: "任务会话 / 滚动位置 / 位置记忆只在软件开启期间有效（裁决 5）",
    steps: "准备同一个内容比视口高的任务会话 → 重载页面（等同「关闭软件重开」：位置记忆清零）→ 点任务行，断言一打开就在底部 → 发一条长回复请求 → 回合结束前点一个普通会话切走 → 等任务行出现绿点 → 再点任务行",
    expect: "重开后打开停在最底部（不回到重载前离开的位置）；切走那一刻在底部；后台来了新回复，回来仍停在最底部，新回复的最后内容在屏幕上",
    needs: "model",
    timeoutMs: 480000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.ensureWorkspace();
      await app.closeGuideCards();
      const fx = await ensureTallTask(ctx);
      if (!fx) ctx.skip("当前项目没有内容比视口高的任务会话（也造不出来），量不出停在哪");
      const { task } = fx;
      const leftMidBefore = Boolean(ctx.state.tallTaskLeftMid);
      // 重载前先离开任务会话（停到新对话页）：这一下离开会把当前停留位置记下来（TS-2 是翻着离开的），
      // 重载后它不该被用上
      await app.newConversation();
      const fresh = await reloadFresh(ctx);
      if (!fresh.reloaded) ctx.skip(fresh.reason);
      // 「关闭软件重开」后的第一次打开：必须停在底部——TS-2 刚才是翻着离开的，位置记忆不该留到重开之后。
      // 不再先手动滚到底：打开时在不在底部，正是这里要断言的。
      const row = taskRowOf(app, task);
      await row.waitFor({ state: "visible", timeout: 15000 });
      await openTaskAndWait(ctx, row, task);
      const opened = await settleView(ctx);
      if (!(opened && opened.scrollHeight > opened.clientHeight + 80)) ctx.skip(`这个任务会话的内容不够长（${JSON.stringify(opened)}），量不出停在哪`);
      if (!opened.atBottom) {
        throw new Error(
          `重开后打开任务会话，没有停在最底部（滚动位置 ${opened.scrollTop}；重载前${leftMidBefore ? "是翻着离开的" : "没有翻着离开过"}——位置记忆应随关闭清除）：${JSON.stringify(opened)}`,
        );
      }
      await app.send(SLOW_MESSAGE);
      const started = await app.awaitTurnStart(20000);
      if (!started) ctx.skip("模型不可用：消息发出后 20 秒内回合未启动");
      const leaving = await viewState(page);
      const left = await leaveToRegularSession(ctx, task);
      if (!left) ctx.skip("项目里没有别的会话可以切过去");
      if (!leaving?.atBottom) throw new Error(`发消息之后、切走之前视图不在底部（${JSON.stringify(leaving)}）——打开时没停在底部`);
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
      return { 任务: task.title.slice(0, 24), 重载前翻着离开过: leftMidBefore, 重开后: opened, 切走时: leaving, 后台回合留下的: state, 回来后: after, 页面末尾: tail };
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
      const started = await app.awaitTurnStart(20000);
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
  {
    id: "TS-5",
    name: "读磁盘期间切到别的会话：晚到的结果不留痕迹",
    feature: "打开会话 / 普通会话 / 评审 R2-10（回归用例：打开函数不再等读取结果，晚到的结果仍不能遮黑新会话、改选中态）",
    steps: "找消息多的普通会话：打开 P（内容高过视口 700 像素）、往上翻 500 像素 → 让 A 的读盘慢 2.5 秒（A 挨个试到真的读盘的那个）→ 点 A → 点 B，等 B 的消息上屏 → 之后每 50 毫秒看一次 B 的消息区有没有被遮住、选中的是不是 B（A 的结果两秒后回来）→ 再点 A，看它第一次真正显示时停在哪 → 恢复后端调用入口",
    expect: "被拖慢的那次读盘确实是 A 的；A 的结果回来后 B 的消息区没有被遮住；选中的一直是 B；之后第一次打开 A 停在最底部",
    needs: "none",
    timeoutMs: 180000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.ensureWorkspace();
      await app.closeGuideCards();
      const info = await app.projectInfo();
      if (!info) ctx.skip("当前项目不在项目列表里，拿不到项目标识");
      // 按当前会话用的智能体列会话（原来写死内建引擎：当前智能体不是它时，列出来的和侧栏里的对不上）
      const agentId = await app.chatAgentId();
      const listed = await app.invoke("list_sessions", { agentId, encodedName: info.encoded_name }).catch(() => []);
      const ranked = (Array.isArray(listed) ? listed : [])
        .filter((s) => (Array.isArray(s.messages) ? s.messages.length : 0) >= 2 && (s.display_name ?? "").trim())
        .sort((a, b) => b.messages.length - a.messages.length)
        .slice(0, 30);
      if (ranked.length < 3) ctx.skip(`项目里消息不少于 2 条的普通会话只有 ${ranked.length} 个，凑不齐 P、A、B`);
      const titleOf = (s) => (s.display_name ?? "").trim();
      const rowsOf = (s) => regularRows(app).filter({ has: page.locator(`span.truncate[title=${JSON.stringify(titleOf(s))}]`) });
      // 打开后校验会话头：标题相同的会话不止一个，落到哪个只能看会话头的短号
      const openRecord = async (s) => {
        const rows = rowsOf(s);
        const n = await rows.count();
        for (let i = 0; i < Math.min(n, 4); i++) {
          await rows.nth(i).click();
          await app.sleep(400);
          const head = await app.sessionHeader();
          if (head?.id && s.id.startsWith(head.id)) return true;
        }
        return false;
      };
      const tried = new Set();
      // P：内容要高过视口 700 像素以上，往上翻 500 像素后离底部还有一段距离
      let P = null;
      for (const s of ranked) {
        if (s.messages.length < 6) continue;
        if (!(await openRecord(s))) continue;
        tried.add(s.id);
        const view = await settleView(ctx);
        if (view && view.scrollHeight > view.clientHeight + 700) {
          P = s;
          break;
        }
      }
      if (!P) ctx.skip("消息最多的几个会话里没有一个内容高过视口 700 像素，翻不出有意义的离开位置");
      await wheelToBottom(ctx);
      await page.locator('[data-turn-scope="main"]').first().hover({ position: { x: 160, y: 160 } });
      await page.mouse.wheel(0, -500);
      await app.sleep(500);
      const leftView = await settleView(ctx);
      if (!(leftView && leftView.scrollTop > 100 && leftView.scrollHeight - leftView.scrollTop - leftView.clientHeight > 300)) {
        ctx.skip(`P 往上翻不动（${JSON.stringify(leftView)}）`);
      }
      // 让指定会话的下一次读盘慢 2.5 秒（只慢那一个会话的；别的会话照常读）。
      // 在测试进程里拦截应用的 IPC 请求（Tauri 的调用走 ipc.localhost 这个地址，路径就是命令名）。
      // 页面里包不了：window.__TAURI_INTERNALS__ 是不可改写的全局，整个换掉会被静默忽略（首跑实跑踩到，
      // 布防返回 false、用例只能跳过）。布防之后先自己发一次调用，确认请求确实经过了这层拦截。
      const slow = { target: null, used: false, usedFor: null, seen: 0 };
      const isIpc = (url) => /ipc\.localhost\/|ipc:\/\//.test(url);
      const ipcGate = async (route) => {
        slow.seen += 1;
        const command = new URL(route.request().url()).pathname.replace(/^\//, "");
        if (command === "get_session_messages" && slow.target !== null && !slow.used) {
          const args = (() => {
            try {
              // 请求体就是参数本身（Tauri v2 的调用：JSON 直接入体，没有外层包装）。收口轮订正：
              // 原先取的是 body.payload——那一层并不存在，哪个会话都对不上，一律被当成「有缓存」，
              // 这块用例在此之前从没真正跑过（安装包上用探针看了请求的真实形状才查到）
              const body = route.request().postDataJSON();
              return body && typeof body === "object" && !Array.isArray(body) ? body : {};
            } catch {
              return {};
            }
          })();
          if (args.sessionId === slow.target) {
            slow.used = true;
            slow.usedFor = args.sessionId;
            await new Promise((resolve) => setTimeout(resolve, 2500));
          }
        }
        await route.continue();
      };
      await page.route(isIpc, ipcGate);
      const seenBefore = slow.seen;
      await app.invoke("list_sessions", { agentId, encodedName: info.encoded_name }).catch(() => []);
      const armed = slow.seen > seenBefore;
      if (!armed) {
        await page.unroute(isIpc, ipcGate).catch(() => {});
        ctx.skip("拦不到应用的后端调用请求（地址不是 ipc.localhost 这一类），没法让读盘变慢（前提不成立）");
      }
      try {
        // A：挨个候选试，直到有一个真的走了读盘（有缓存的会话不读盘，复现不了——原来直接跳过）
        let A = null;
        let clickedAAt = 0;
        for (const s of ranked) {
          if (tried.has(s.id)) continue;
          if (!(await rowsOf(s).count())) continue;
          tried.add(s.id);
          slow.target = s.id;
          slow.used = false;
          slow.usedFor = null;
          clickedAAt = Date.now();
          await rowsOf(s).first().click();
          const deadline = Date.now() + 1500;
          while (Date.now() < deadline && !slow.used) await app.sleep(100);
          const used = slow.used;
          const head = await app.sessionHeader();
          if (used && head?.id && s.id.startsWith(head.id)) {
            A = s;
            break;
          }
        }
        if (!A) ctx.skip("这些会话的消息都有缓存（没走读盘），复现不了——应用重启后单独跑本块");
        const delayedFor = slow.usedFor;
        // B：另一个会话。等它的消息上屏、停稳了才开始盯——B 自己打开那一下的遮蔽不算数
        let B = P;
        for (const s of ranked) {
          if (tried.has(s.id)) continue;
          if (await rowsOf(s).count()) {
            B = s;
            break;
          }
        }
        await rowsOf(B).first().click();
        await expect(messageRows(page).first()).toBeVisible({ timeout: 15000 });
        await settleView(ctx);
        await page.evaluate((expectId) => {
          const state = (window.__ts5sample = { samples: 0, masked: 0, drifted: 0, headMissing: 0, timer: null });
          state.expect = expectId;
          state.timer = setInterval(() => {
            const main = document.querySelector('[data-turn-scope="main"]');
            let el = main;
            while (el && el !== document.body) {
              if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) break;
              el = el.parentElement;
            }
            const scroller = el && el !== document.body ? el : main;
            const masked =
              !main ||
              getComputedStyle(scroller).visibility === "hidden" ||
              [...main.querySelectorAll('[style*="visibility: hidden"]')].some((node) => node.style?.visibility === "hidden");
            const idEl = [...document.querySelectorAll("span.font-mono")].find((e) => {
              const r = e.getBoundingClientRect();
              return r.top >= 0 && r.top < 90 && r.left > 230 && /^[0-9a-f]{8}$/.test((e.textContent || "").trim());
            });
            state.samples += 1;
            if (masked) state.masked += 1;
            if (!idEl) state.headMissing += 1;
            else if (!state.expect.startsWith(idEl.textContent.trim())) state.drifted += 1;
          }, 50);
        }, B.id);
        // A 的结果在点 A 之后 2.5 秒回来：从点 A 起总共盯 4 秒，把它回来前后都盖住
        await app.sleep(Math.max(600, 4000 - (Date.now() - clickedAAt)));
        const sampled = await page.evaluate(() => {
          const state = window.__ts5sample;
          clearInterval(state.timer);
          return { 采样次数: state.samples, 被遮住次数: state.masked, 选中态跑偏次数: state.drifted, 读不到会话头的次数: state.headMissing };
        });
        const head = await app.sessionHeader();
        const stillB = Boolean(head?.id) && B.id.startsWith(head.id);
        await ctx.shot("TS5-A的结果回来之后");

        // A 第一次真正显示：停在哪
        if (!(await openRecord(A))) throw new Error("之后再点 A，落点不是 A");
        await expect(messageRows(page).first()).toBeVisible({ timeout: 15000 });
        await settleView(ctx);
        await app.sleep(3200);
        const aView = await settleView(ctx);
        await ctx.shot("TS5-A第一次真正显示");
        const facts = {
          P: { 消息数: P.messages.length, 离开位置: leftView.scrollTop },
          A: { 消息数: A.messages.length },
          B: { 消息数: B.messages.length },
          被拖慢的读盘是A的: delayedFor === A.id,
          A结果回来期间: sampled,
          选中的还是B: stillB,
          A第一次显示的视图: aView,
        };
        if (delayedFor !== A.id) throw new Error(`被拖慢的那次读盘不是 A 的（拖慢的是 ${String(delayedFor).slice(0, 8)}，A 是 ${A.id.slice(0, 8)}）：${JSON.stringify(facts)}`);
        if (!stillB || sampled.选中态跑偏次数 > 0) throw new Error(`A 的结果回来后选中的会话变了：${JSON.stringify(facts)}`);
        if (sampled.被遮住次数 > 0) throw new Error(`A 的结果回来后，B 的消息区被遮住了（${sampled.被遮住次数}/${sampled.采样次数} 次采样）：${JSON.stringify(facts)}`);
        if (aView && aView.scrollHeight > aView.clientHeight + 700 && !aView.atBottom) {
          throw new Error(`A 第一次真正显示时没有停在最底部：${JSON.stringify(facts)}`);
        }
        return facts;
      } finally {
        // 撤掉拦截、停掉采样
        await page.unroute(isIpc, ipcGate).catch(() => {});
        await page
          .evaluate(() => {
            clearInterval(window.__ts5sample?.timer);
            delete window.__ts5sample;
          })
          .catch(() => {});
      }
    },
  },
  {
    id: "TS-6",
    name: "从往上翻着的会话切到别的会话：不空白、落在最底部",
    feature: "打开会话 / 滚动定位 / 评审 R2-5（回归用例；「离开底部」标记要在程序性定位时当场更新）",
    steps: "找两个内容都比视口高的普通会话 P、Q → 对照：P 停在底部时点 Q，量消息区被遮黑多久 → 点回 P、往上翻 600 像素 → 再点 Q，再量一次",
    expect: "两次消息区都在 150 毫秒内显示出来（定位完就上屏，不等 800 毫秒的保险）；两次 Q 都停在最底部",
    needs: "none",
    timeoutMs: 180000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.ensureWorkspace();
      await app.closeGuideCards();
      const info = await app.projectInfo();
      if (!info) ctx.skip("当前项目不在项目列表里，拿不到项目标识");
      // 按当前会话用的智能体列会话（原来写死内建引擎：当前智能体不是它时，列出来的和侧栏里的对不上）
      const agentId = await app.chatAgentId();
      const listed = await app.invoke("list_sessions", { agentId, encodedName: info.encoded_name }).catch(() => []);
      const ranked = (Array.isArray(listed) ? listed : [])
        .filter((s) => s.messages.length >= 6 && (s.display_name ?? "").trim())
        .sort((a, b) => b.messages.length - a.messages.length)
        .slice(0, 12);
      const rowOf = (s) =>
        regularRows(app).filter({ has: page.locator(`span.truncate[title=${JSON.stringify(s.display_name.trim())}]`) }).first();
      // 打开后校验会话头：标题相同的会话不止一个，落到哪个只能看会话头的短号
      const openRecord = async (s) => {
        const rows = regularRows(app).filter({ has: page.locator(`span.truncate[title=${JSON.stringify(s.display_name.trim())}]`) });
        const n = await rows.count();
        for (let i = 0; i < Math.min(n, 4); i++) {
          await rows.nth(i).click();
          await app.sleep(400);
          const head = await app.sessionHeader();
          if (head?.id && s.id.startsWith(head.id)) {
            await settleView(ctx);
            return true;
          }
        }
        return false;
      };
      // P 要能往上翻 600 像素（比视口高 700 以上）；Q 只要比视口高 300 以上，够判断「在不在底部」
      let P = null;
      let Q = null;
      for (const s of ranked) {
        if (!(await openRecord(s))) continue;
        const view = await settleView(ctx);
        if (!view) continue;
        const extra = view.scrollHeight - view.clientHeight;
        if (!P && extra > 700) P = s;
        else if (!Q && extra > 300) Q = s;
        if (P && Q) break;
      }
      if (!P) ctx.skip("内容比视口高 700 像素以上的普通会话一个都没有，翻不出有意义的离开位置");
      if (!Q) ctx.skip("除了 P，没有别的比视口高 300 像素以上的普通会话可以切过去");
      // 盯消息区：每 25 毫秒看一次是不是被遮黑（定位期间消息区整体隐藏）
      const startSampler = () =>
        page.evaluate(() => {
          const s = (window.__ts6 = { t0: performance.now(), hiddenSamples: 0, samples: 0, firstVisibleAt: null, timer: null });
          s.timer = setInterval(() => {
            const main = document.querySelector('[data-turn-scope="main"]');
            let el = main;
            while (el && el !== document.body) {
              if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) break;
              el = el.parentElement;
            }
            s.samples += 1;
            // 遮蔽在滚动容器自己身上（内联样式）、或在它的哪一层祖先上（计算值会继承下来）、或是主区里
            // 被内联样式隐藏的节点——三处任一都算（实现挪到哪一层都量得到）
            const hidden = Boolean(
              main &&
                (el?.style?.visibility === "hidden" ||
                  (el && el !== document.body && getComputedStyle(el).visibility === "hidden") ||
                  [...main.querySelectorAll('[style*="visibility: hidden"]')].some((node) => node.style?.visibility === "hidden")),
            );
            if (hidden) s.hiddenSamples += 1;
            else if (s.firstVisibleAt === null) s.firstVisibleAt = Math.round(performance.now() - s.t0);
          }, 25);
        });
      const stopSampler = async () => {
        await page.evaluate(() => clearInterval(window.__ts6.timer));
        const s = await page.evaluate(() => ({ 遮黑毫秒: window.__ts6.hiddenSamples * 25, 首次可见于毫秒: window.__ts6.firstVisibleAt }));
        return { ...s, 视图: await settleView(ctx) };
      };

      // 对照：P 停在底部（「离开底部」标记为假）时点 Q
      if (!(await openRecord(P))) ctx.skip("侧栏里找不到 P 的会话行");
      await wheelToBottom(ctx);
      await startSampler();
      await rowOf(Q).click();
      await app.sleep(2500);
      const control = await stopSampler();
      await ctx.shot("TS6-对照-从底部切过去");

      // 测试：P 往上翻 600 像素（「离开底部」标记为真）时点 Q
      await openRecord(P);
      await settleView(ctx);
      await page.locator('[data-turn-scope="main"]').first().hover({ position: { x: 160, y: 160 } });
      await page.mouse.wheel(0, -600);
      await app.sleep(600);
      const left = await settleView(ctx);
      if (!(left && !left.atBottom && left.scrollTop > 100)) ctx.skip(`P 往上翻不动（${JSON.stringify(left)}）`);
      await startSampler();
      await rowOf(Q).click();
      await app.sleep(450);
      await ctx.shot("TS6-测试-从往上翻着的会话切过去");
      await app.sleep(2100);
      const test = await stopSampler();
      const head = await app.sessionHeader();
      if (!(head?.id && Q.id.startsWith(head.id))) throw new Error(`点 Q 之后选中的不是 Q：${JSON.stringify({ control, test })}`);
      const facts = { P: { 消息数: P.messages.length, 离开位置: left.scrollTop }, 对照_从底部切过去: control, 测试_从往上翻着的会话切过去: test };
      if (test.遮黑毫秒 > 150) throw new Error(`从往上翻着的会话切过去，消息区空白了约 ${test.遮黑毫秒} 毫秒：${JSON.stringify(facts)}`);
      if (test.视图 && test.视图.scrollHeight > test.视图.clientHeight + 100 && !test.视图.atBottom) {
        throw new Error(`从往上翻着的会话切过去，Q 没有停在最底部：${JSON.stringify(facts)}`);
      }
      return facts;
    },
  },
].map(withCleanup);
