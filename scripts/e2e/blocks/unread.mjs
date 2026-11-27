/**
 * 积木：v0.9.8 需求24 任务会话的绿点点击后无法消除（UN-1、UN-2）。
 * 对应需求文档 docs/v0.9.8/需求24-任务会话绿点点击后无法消除/（tests/06-测试清单 第二节）。
 *
 * 行首的绿点 / 红点 = 这个会话有没看过的结果：回合在会话没被查看时结束就记一笔，点开这个
 * 会话就该清掉。怎么造出一笔未读：在会话里发一条慢消息，回合结束前点「新对话」切走——
 * 回合在后台结束，行首出现绿点。
 *
 * 两条都需要可用模型。UN-1 往项目里已有的一个任务会话发一条消息（项目里没有任务会话时
 * 先造一个——造数不让智能体调用工具，不往项目里写任何文件）；UN-2 新建一个对话。
 * 这些会话留在项目里不删。
 */
import fs from "node:fs";
import { expect } from "../lib-pw.mjs";

// 让回复足够长，切走之后回合才结束（实测 glm-5.3-flash 数到 150 只要 3~8 秒）
const SLOW_MESSAGE = "不要调用任何工具。请从 1 数到 600，每行一个数字，只输出数字。";

/** 常规会话行（标题带完整标题提示的那一类；任务会话的行不在此列）。 */
const regularRows = (app) => app.sidebar().locator("button.flex-col.items-start").filter({ has: app.page.locator("span.truncate[title]") });
const titleOf = (row) => row.locator("span.truncate").first().textContent().then((s) => (s || "").trim());

const isUnread = (state) => state === "done" || state === "failed";




/**
 * 在当前会话里发一条慢消息，回合结束前点「新对话」切走。
 * 返回 { started, stateAfterLeave }：回合是否确认启动；切走那一刻这一行的状态——
 * 不是「进行中」就说明回合在切走前结束了，这样造不出「后台完成」的未读。
 */
const sendAndLeave = async (ctx, text, row) => {
  const { app, page } = ctx;
  await app.send(text);
  const started = await app.awaitTurnStart(20000);
  if (!started) return { started: false, stateAfterLeave: null };
  await app.newConversation();
  return { started: true, stateAfterLeave: await app.rowState(row) };
};

/** 各步耗时（毫秒）——如实记录，卡在哪一步一眼可见。 */
const steps = () => {
  const t0 = Date.now();
  const taken = {};
  let last = t0;
  return {
    mark(name) {
      const now = Date.now();
      taken[name] = now - last;
      last = now;
    },
    done() {
      taken["合计"] = Date.now() - t0;
      return taken;
    },
  };
};

/**
 * 造任务用：留作任务主会话的一条最短消息——不调用工具（2026-11-27 用户裁决后造任务只走真实
 * 用户路径：点「新任务」发这条目标，任务由发送链路真实创建，不再直调后端命令建图挂会话）。
 */
const TASK_MAIN_MESSAGE = "不要调用任何工具。只回复两个字：收到。";

/** 项目根目录下的普通文件名（只看根这一层：会话文件、任务工作区都落在子目录里，那是产品自己的东西）。读不了返回 null。 */
const rootFiles = (root) => {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
};

/**
 * 项目里没有任务会话时造一个——**真实用户路径**（2026-11-27 用户裁决：测试禁止直造数据）：
 * 点「新任务」发一条「只回复文字」的目标，任务由发送链路真实创建。目标提示词写明不调用工具，
 * 不往用户的项目里写任何文件；造完核对项目根目录没有多出普通文件。
 */
const createTask = async (ctx) => {
  const { app } = ctx;
  const project = await app.projectInfo();
  if (!project?.path) ctx.skip("认不出当前项目的目录，没法造任务");
  const before = rootFiles(project.path);
  let made;
  try {
    made = await app.createTaskViaGui({ goal: TASK_MAIN_MESSAGE });
  } catch (e) {
    if (/^模型不可用/.test(String(e?.message || e))) ctx.skip(e.message);
    throw e;
  }
  if (before) {
    const added = (rootFiles(project.path) ?? []).filter((name) => !before.includes(name));
    if (added.length) throw new Error(`造任务的过程中项目根目录多出了文件：${added.join("、")}（造任务不该写任何文件）`);
  }
  ctx.state.unreadTask = made;
  await app.taskRows().first().waitFor({ state: "visible", timeout: 30000 });
};

/** 开始时任务列表里已经带绿点 / 红点的行：逐个点开再切走，必须不再出现。返回处理了几行。 */
const clearStaleTaskDots = async (ctx, records) => {
  const { app } = ctx;
  const total = await app.taskRows().count();
  const dotted = [];
  for (let i = 0; i < total; i++) {
    const state = await app.rowState(app.taskRows().nth(i));
    if (isUnread(state)) dotted.push(await titleOf(app.taskRows().nth(i)));
  }
  for (const title of dotted) {
    const row = app.taskRows().filter({ hasText: title }).first();
    await app.openTaskRow(row, records.find((r) => r.title === title) ?? { title, task_session_id: "" });
    await app.newConversation();
    const state = await app.rowState(row);
    if (isUnread(state)) throw new Error(`带${state === "done" ? "绿" : "红"}点的任务「${title}」点开又切走后还在`);
  }
  return dotted.length;
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

export const unreadCases = [
  {
    id: "UN-1",
    name: "任务会话的绿点：点开后不再出现",
    feature: "任务会话行 / 未读标记 / 需求24",
    steps: "已有的绿点：点开再切走 → 打开一个任务会话发一条慢消息 → 回合结束前点「新对话」切走 → 等任务行出现绿点 → 点任务行 → 再点「新对话」",
    expect: "已有的绿点不再出现；新产生的绿点在点开任务又切走后也不出现",
    needs: "model",
    timeoutMs: 480000,
    run: async (ctx) => {
      const { app, page } = ctx;
      const timing = steps();
      await app.ensureWorkspace();
      await app.closeGuideCards();
      timing.mark("准备");
      let records = await app.taskRecords();
      if (!(await app.taskRows().count())) await createTask(ctx);
      records = await app.taskRecords();
      timing.mark("读任务列表");
      const task = records.find((r) => r.task_session_id);
      if (!task) ctx.skip("当前项目的任务都没有关联会话，没法在里面发消息");

      const staleCleared = await clearStaleTaskDots(ctx, records);
      timing.mark("处理已有的绿点");

      const row = app.sidebar().locator(`button[data-task-id="${task.task_id}"]`).first(); // 按任务号找：标题会重复
      await app.openTaskRow(row, task);
      const sent = await sendAndLeave(ctx, SLOW_MESSAGE, row);
      timing.mark("发消息并切走");
      if (!sent.started) ctx.skip("模型不可用：消息发出后 20 秒内回合未启动");
      if (sent.stateAfterLeave !== "streaming") {
        ctx.skip(`切走那一刻回合已经不在进行（行状态 ${sent.stateAfterLeave}）——造不出「后台完成」的未读，请把 SLOW_MESSAGE 加长`);
      }
      // 后台回合结束：任务行先蓝后绿
      const state = await app.waitRowState(row, ["done", "failed"], 180000);
      timing.mark("等后台回合结束");
      if (!isUnread(state)) ctx.skip(`回合没有在后台留下未读（最后看到的行状态是 ${state}）`);
      await ctx.shot("UN1-任务行出现未读点");

      await app.openTaskRow(row, task);
      await app.newConversation();
      await expect(row).toBeVisible();
      await page.waitForTimeout(800);
      const after = await app.rowState(row);
      timing.mark("点开再切走");
      if (isUnread(after)) throw new Error(`任务行点开又切走后${after === "done" ? "绿" : "红"}点还在`);
      await ctx.shot("UN1-点开切走后");
      return {
        任务: task.title.slice(0, 24),
        开始时已有的绿点行: staleCleared,
        切走那一刻: sent.stateAfterLeave,
        后台回合留下的: state,
        点开切走后: after,
        各步耗时: timing.done(),
      };
    },
  },
  {
    id: "UN-2",
    name: "普通会话的行为不变：绿点点开后不再出现",
    feature: "常规会话行 / 未读标记 / 需求24 回归",
    steps: "记下已有绿点的行 → 新对话发一条慢消息 → 回合结束前点「新对话」切走 → 等新会话的行带着绿点出现 → 点开 → 再点「新对话」",
    expect: "新会话行的绿点在点开又切走后不出现",
    needs: "model",
    timeoutMs: 420000,
    run: async (ctx) => {
      const { app, page } = ctx;
      const timing = steps();
      await app.ensureWorkspace();
      await app.closeGuideCards();
      timing.mark("准备");
      // 「新出现的带点行」= 行首有绿 / 红点，且标题不在一开始记下的那批里（行下标供定位用）
      const freshIndex = (known) =>
        page.evaluate((list) => {
          const rows = [...document.querySelectorAll(".chat-sidebar button.flex-col.items-start")];
          return rows.findIndex(
            (row) =>
              row.querySelector("span.rounded-full.bg-emerald-500, span.rounded-full.bg-red-500") &&
              !list.includes(row.querySelector("span.truncate[title]")?.getAttribute("title") ?? ""),
          );
        }, known);
      const known = await page.evaluate(() =>
        [...document.querySelectorAll(".chat-sidebar button.flex-col.items-start")]
          .filter((row) => row.querySelector("span.rounded-full.bg-emerald-500, span.rounded-full.bg-red-500"))
          .map((row) => row.querySelector("span.truncate[title]")?.getAttribute("title") ?? ""),
      );
      await app.newConversation();
      // 新对话发出消息后列表最上面立刻出现它这一行（标题先是「新对话」或消息开头）
      const sent = await sendAndLeave(ctx, SLOW_MESSAGE, regularRows(app).first());
      timing.mark("发消息并切走");
      if (!sent.started) ctx.skip("模型不可用：消息发出后 20 秒内回合未启动");
      if (sent.stateAfterLeave !== "streaming") {
        ctx.skip(`切走那一刻回合已经不在进行（行状态 ${sent.stateAfterLeave}）——造不出「后台完成」的未读，请把 SLOW_MESSAGE 加长`);
      }

      // 回合在后台结束——这一行带着绿点
      const deadline = Date.now() + 180000;
      let idx = await freshIndex(known);
      while (idx < 0 && Date.now() < deadline) {
        await page.waitForTimeout(800);
        idx = await freshIndex(known);
      }
      timing.mark("等后台回合结束");
      if (idx < 0) ctx.skip("后台回合没有留下带绿点的会话行——可能切走前就结束了");
      await ctx.shot("UN2-新会话行出现绿点");

      // 标题可能正被自动改写：落点校验看「会话头标题 = 这一行此刻的标题」
      const row = regularRows(app).nth(idx);
      await row.click();
      await expect
        .poll(
          async () => {
            const head = await app.sessionHeader();
            return Boolean(head) && head.title === ((await row.locator("span.truncate[title]").first().getAttribute("title")) || "").trim();
          },
          { timeout: 10000 },
        )
        .toBe(true);

      await app.newConversation();
      await page.waitForTimeout(800);
      const after = await freshIndex(known);
      timing.mark("点开再切走");
      if (after >= 0) throw new Error("会话行点开又切走后绿点还在");
      await ctx.shot("UN2-点开切走后");
      return { 开始时已有的绿点行: known.length, 切走那一刻: sent.stateAfterLeave, 点开切走后: "没有绿点", 各步耗时: timing.done() };
    },
  },
].map(withCleanup);
