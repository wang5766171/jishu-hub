/**
 * 积木：v0.9.8 需求7 补充轮——斜杠命令与上下文压缩（EC-1~EC-9）。
 * 对应需求7 补充轮文档 docs/v0.9.8/需求7-加号引用菜单聚合/06-补充轮-斜杠命令与压缩.md。
 * 用户原话：「我用/命令，我没有点发送，只是选择了compact这个命令就自动发送了，这是不对的，
 * 应该点了之后只是落到输入框，只有点击发送才发送」。
 *
 * 与其他积木文件不同的两点：
 * - 压缩要求会话「够大」，而且要大对形状：引擎从最新往回累加，攒够「保留近期内容」的
 *   预算（默认 2 万 token）才落切点，切点之前的历史才会被摘要——所以一条大消息不够
 *   （它自己就超预算，整条被保留，引擎报「没有可压缩的内容」），要先发一条、再发一条：
 *   后一条连同它的回复被保留，前一条被摘要。每条需要压缩的用例因此往新会话发两条各约
 *   9 万字符的「接口清单」（按引擎「4 字符 ≈ 1 token」的估算各约 2.3 万 token）——
 *   会占用模型用量，也会在当前项目留下测试会话（每块自己新建，留在项目里不删）。
 * - EC-5 会真的取消一次压缩；其余用例的压缩都会跑完。各用例各用自己的会话。
 */
import os from "node:os";
import path from "node:path";
import { expect } from "../lib-pw.mjs";
import { pickInjectableTool, reloadIntoSession } from "./fix-round.mjs";

// 一份「接口清单」的行数：每行约 130 字符 → 约 9 万字符。引擎按「4 字符 ≈ 1 token」估算
// 约 2.3 万 token，单独一条就超过「保留近期内容」的预算（默认 2 万 token）——这样第二条
// 清单会被整条保留、第一条被摘要，会话才可压缩。
const SPEC_LINES = 700;
const stopBtn = (page) => page.locator('button[title="停止"]:not([disabled])').first();
const sendBtn = (page) => page.locator('button[title="发送"]').first();
/** 当前这次压缩的分隔线（会话里可能留着以前压缩的分隔线——取最后一条）。 */
const divider = (page) => page.locator('[data-phase="compaction"]').last();
const elapsedLabel = (page) => page.getByText(/^已用时 (\d+ 秒|\d+ 分 \d\d 秒)$/).first();
/** 命令面板里名为 /name 的那一项。 */
const slashItem = (page, name) => page.locator("button").filter({ has: page.locator(`span.font-mono:text-is("/${name}")`) });
/** 输入框右侧「上下文已用 N%」的水位圆环（点开是用量弹层，里面有「立即压缩」）。 */
const ringTrigger = (page) => page.locator('button[aria-haspopup="dialog"][aria-label^="上下文已用"]').first();
const unsentBadges = (page) => page.getByText("未送达", { exact: true });
const failedDialog = (page) => page.getByRole("dialog").filter({ hasText: "压缩失败" });
const TERMINAL = /上下文已压缩|上下文压缩已取消|上下文压缩失败/;

/** 生成一份确定性的「接口清单」：每行一条接口，内容随序号变化。 */
function apiSpec(start, lines) {
  const methods = ["GET", "POST", "PUT", "DELETE"];
  const resources = ["agent", "interface", "skill", "plugin", "session", "task", "artifact", "channel"];
  const fields = ["id", "name", "version", "status", "owner", "updatedAt"];
  const out = [];
  for (let i = 0; i < lines; i++) {
    const n = start + i;
    const resource = resources[n % resources.length];
    const f1 = fields[n % fields.length];
    const f2 = fields[(n * 7 + 3) % fields.length];
    out.push(
      `${String(n).padStart(6, "0")} ${methods[n % methods.length]} /api/v1/${resource}s/{${resource}Id}/${f1} desc=${resource}-${f1}-query-${n} auth=accessKey scope=${f2} tags=release_${(n % 17) + 1}`,
    );
  }
  return out.join("\n");
}

async function begin(ctx) {
  await ctx.app.ensureWorkspace();
  await ctx.app.closeGuideCards();
  await ctx.app.newConversation();
  ctx.state.sessionsCreated += 1;
  ctx.since = Date.now();
}

async function finishTurn(ctx, budget = 300000) {
  const { app } = ctx;
  const turn = await app.waitTurn({ budgetMs: budget });
  if (!turn.done) throw new Error("回合未在时限内结束");
  const idle = await app.waitIdle(4000, budget);
  if (!idle.idle) throw new Error("回合结束后未进入空闲");
}

/** 模型可用性探测：发送后看停止钮是否出现。不可用就标记并跳过。 */
async function expectTurnStarted(ctx, what) {
  const { app } = ctx;
  const started = await stopBtn(app.page).waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false);
  if (!started) {
    ctx.state.modelOk = false;
    ctx.skip(`模型不可用：${what}发出后 20 秒内回合未启动`);
  }
  ctx.state.modelOk = true;
}

/**
 * 新建会话并发两条很长的「接口清单」，使它可压缩：第二条连同回复被引擎保留，第一条被摘要。
 * 第二条尽量挂一个工具：带注入块的消息正是「未送达」影子（评审 R1-1）的触发形态，
 * EC-4 要在这个形态下验证压缩后重开会话没有影子。
 */
async function growCompactableSession(ctx) {
  const { app } = ctx;
  if (ctx.state.modelOk === false) ctx.skip("模型不可用（本轮已判定）");
  await begin(ctx);
  const nonce = String(Date.now()).slice(-6);
  // 每个会话的清单从不同序号起——内容各不相同，不会被当成重复消息
  const base = (ctx.state.compactSpecOffset || 0) + SPEC_LINES;
  ctx.state.compactSpecOffset = base + SPEC_LINES;
  const specA = apiSpec(base, SPEC_LINES);
  const specB = apiSpec(base + SPEC_LINES, SPEC_LINES);
  // 第一条：之后被摘要
  await app.send(`下面是第一份接口清单（编号 ${nonce}），先记住，之后会用到。这一条只回复两个字：收到。\n\n${specA}`);
  await expectTurnStarted(ctx, "第一条接口清单");
  await finishTurn(ctx, 420000);

  // 第二条：之后被保留
  const tool = await pickInjectableTool(ctx);
  await app.type(`下面是第二份接口清单（编号 ${nonce}），同样先记住。这一条只回复两个字：好的。\n\n${specB}`, { append: true });
  await app.composer().press("Enter");
  await expectTurnStarted(ctx, "第二条接口清单");
  await finishTurn(ctx, 420000);
  const head = await app.sessionHeader();
  if (!head) throw new Error("读不到会话头");
  return { nonce, shortId: head.id, 两份清单字符数: specA.length + specB.length, 第二条挂的工具: tool ?? "(没有可挂的工具)" };
}

/**
 * 日志中心快照（前端埋点 + 后端 [runtime] 桥接）。开发模式下后端日志桥接会挂两次，
 * 同一条后端日志连续到达两遍——连续两条完全相同的算一条（生产构建没有这个重复）。
 */
const devLogs = async (app) => {
  const raw = await app.ev(() => window.__jishuDevLogs?.get?.() ?? []);
  const out = [];
  for (const e of raw) {
    const key = JSON.stringify([e.category, e.message, e.data ?? null]);
    if (out.length && out[out.length - 1].key === key) continue;
    out.push({ key, ts: e.ts, category: e.category, message: e.message, data: e.data });
  }
  return out;
};

const compactRequests = (logs) => logs.filter((e) => /压缩请求已发给引擎|手动压缩会话/.test(e.message));

/** 「已用时 N 秒 / 已用时 M 分 SS 秒」→ 秒数；不是这个文案返回 null。 */
function elapsedSeconds(label) {
  const text = String(label ?? "").trim();
  let m = /^已用时 (\d+) 秒$/.exec(text);
  if (m) return Number(m[1]);
  m = /^已用时 (\d+) 分 (\d\d) 秒$/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 「未送达」账本的行数（~/.jishu-hub/pending_messages.db）；运行环境的 Node 没有 sqlite 模块时返回 null。 */
async function ledgerRows() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(os.homedir(), ".jishu-hub", "pending_messages.db"), { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS n FROM pending_user_messages").get();
    db.close();
    return Number(row.n);
  } catch {
    return null;
  }
}

/** 输入并发送一条压缩命令，等「上下文压缩中…」出现。会话不可压缩时跳过并写明引擎的原话。 */
async function startCompaction(ctx, command = "/compact ") {
  const { app, page } = ctx;
  await app.type(command);
  await sendBtn(page).click();
  await expect(app.composer()).toHaveValue("", { timeout: 5000 });
  await expect(divider(page).or(failedDialog(page).first()).first()).toBeVisible({ timeout: 30000 });
  if (await failedDialog(page).first().isVisible().catch(() => false)) {
    const text = (await failedDialog(page).first().textContent()).replace(/\s+/g, " ").trim();
    await app.cancelResidualDialog();
    ctx.skip(`会话不可压缩（前提不成立）：${text.slice(0, 120)}`);
  }
  await expect(divider(page)).toHaveText("上下文压缩中…");
}

/** 等压缩结束（分隔线变成终态标题），返回终态标题。 */
async function waitCompactionDone(ctx, budgetMs = 300000) {
  const { app, page } = ctx;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const text = ((await divider(page).textContent().catch(() => "")) || "").trim();
    if (TERMINAL.test(text)) return text;
    await app.sleep(500);
  }
  throw new Error("压缩未在时限内结束");
}

/** 只数消息区的文本（侧栏会话行的标题就是消息开头，整页计数会被污染）。 */
const mainText = (page) =>
  page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll(".chat-sidebar").forEach((e) => e.remove());
    clone.querySelectorAll("textarea").forEach((e) => e.remove());
    return (clone.textContent || "").replace(/\s+/g, " ");
  });

export const compactCases = [
  {
    id: "EC-1",
    name: "面板选中 compact 只落入输入框（鼠标点选）",
    feature: "斜杠命令面板 / 需求7 补充轮：选中只填入",
    steps: "新对话发一条短消息建会话 → 输入 /co → 面板出现 compact → 鼠标点选",
    expect: "输入框变成「/compact 」；会话里没有出现压缩分隔线；日志里没有压缩请求",
    needs: "model",
    timeoutMs: 180000,
    run: async (ctx) => {
      const { app, page } = ctx;
      if (ctx.state.modelOk === false) ctx.skip("模型不可用（本轮已判定）");
      // compact 这一项只在已有会话里可用——先建一个会话
      await begin(ctx);
      const nonce = String(Date.now()).slice(-6);
      await app.send(`只回复两个字：收到（压缩验证-${nonce}）`);
      await expectTurnStarted(ctx, "建会话的消息");
      await finishTurn(ctx);
      const head = await app.sessionHeader();

      await app.type("/co", { mode: "keys" });
      const item = slashItem(page, "compact");
      await expect(item).toBeVisible({ timeout: 8000 });
      await item.click();
      await expect(app.composer()).toHaveValue("/compact ");
      await expect(item).toHaveCount(0);
      if ((await divider(page).textContent().catch(() => ""))?.includes("压缩中")) {
        throw new Error("点选 compact 后会话里出现了压缩分隔线（选中即执行，修前表现）");
      }
      const mine = (await devLogs(app)).filter((e) => e.ts >= ctx.since);
      const requests = compactRequests(mine);
      if (requests.length) throw new Error("点选 compact 就发出了压缩请求（修前表现）: " + JSON.stringify(requests[0]));
      await ctx.shot("EC1-选中只填入");
      await app.composer().fill("");
      return { 会话头短id: head?.id, 本轮编号: nonce, 输入框: "/compact ", 压缩请求: 0, 压缩分隔线: 0 };
    },
  },
  {
    id: "EC-2",
    name: "点发送才压缩；压缩中显示用时，完成显示已压缩",
    feature: "发送时本地执行 / 压缩进度（需求7 补充轮）",
    steps: "新会话发一条很长的接口清单和一条短消息 → 输入「/compact 」→ 点发送 → 观察压缩中 → 等完成",
    expect: "出现「上下文压缩中…」和「已用时 N 秒」；完成显示「上下文已压缩」；没有「压缩失败」弹窗",
    needs: "model",
    timeoutMs: 900000,
    run: async (ctx) => {
      const { app, page } = ctx;
      const grown = await growCompactableSession(ctx);
      await startCompaction(ctx);
      await expect(elapsedLabel(page)).toBeVisible({ timeout: 20000 });
      const first = (await elapsedLabel(page).textContent()).trim();
      await ctx.shot("EC2-压缩中显示用时");
      // 用时要真的在走：过 3 秒再读一次（压缩若在 3 秒内就结束了，如实记录为没看到增长）
      await app.sleep(3000);
      const later = (await elapsedLabel(page).textContent().catch(() => "")).trim();
      const grew = later ? elapsedSeconds(later) > elapsedSeconds(first) : null;
      if (later) await ctx.shot("EC2-压缩中3秒后");
      const final = await waitCompactionDone(ctx);
      await ctx.shot("EC2-压缩完成");
      if (final !== "上下文已压缩") throw new Error(`压缩没有成功结束：${final}`);
      if (await failedDialog(page).first().isVisible().catch(() => false)) throw new Error("出现了「压缩失败」弹窗");
      if (grew === false) throw new Error(`用时没有增长：先是「${first}」，3 秒后还是「${later}」`);
      const logs = await devLogs(app);
      const anchors = logs.filter((e) => e.ts >= ctx.since && /上下文压缩开始（引擎事件）|上下文压缩结束（引擎事件）/.test(e.message));
      return { ...grown, 压缩开始时显示: first, 三秒后显示: later || "(压缩已结束)", 用时增长: grew, 结束状态: final, 失败弹窗: false, 引擎事件锚点: anchors.map((e) => e.message) };
    },
  },
  {
    id: "EC-3",
    name: "键盘路径：第一次回车只选中，第二次回车才发送",
    feature: "斜杠命令面板（键盘）/ 发送时本地执行",
    steps: "新会话发一条很长的接口清单和一条短消息 → 输入 /compact → 回车（面板选中）→ 再回车（发送）",
    expect: "第一次回车后输入框是「/compact 」且没有开始压缩；第二次回车后开始压缩并完成",
    needs: "model",
    timeoutMs: 900000,
    run: async (ctx) => {
      const { app, page } = ctx;
      const grown = await growCompactableSession(ctx);
      await app.type("/compact", { mode: "keys" });
      await expect(slashItem(page, "compact")).toBeVisible({ timeout: 8000 });
      await app.composer().press("Enter");
      await expect(app.composer()).toHaveValue("/compact ");
      await expect(slashItem(page, "compact")).toHaveCount(0);
      await app.sleep(1500);
      if (compactRequests((await devLogs(app)).filter((e) => e.ts >= ctx.since)).length) {
        throw new Error("第一次回车（面板选中）就发出了压缩请求（修前表现）");
      }
      await ctx.shot("EC3-第一次回车后");
      await app.composer().press("Enter");
      await expect(app.composer()).toHaveValue("", { timeout: 5000 });
      await expect(divider(page)).toHaveText("上下文压缩中…", { timeout: 30000 });
      const final = await waitCompactionDone(ctx);
      await ctx.shot("EC3-第二次回车后压缩完成");
      if (final !== "上下文已压缩") throw new Error(`压缩没有成功结束：${final}`);
      return { ...grown, 第一次回车后的输入框: "/compact ", 第一次回车后的压缩请求: 0, 结束状态: final };
    },
  },
  {
    id: "EC-4",
    name: "压缩后重开会话没有「未送达」",
    feature: "发送防丢账（评审 R1-1 账本身份化）在压缩场景下的验证",
    steps: "新会话发一条很长的接口清单和一条挂了工具的短消息 → /compact 发送 → 等完成 → 重载页面回到该会话",
    expect: "消息区没有「未送达」徽标；账本行数与压缩前一致",
    needs: "model",
    timeoutMs: 900000,
    run: async (ctx) => {
      const { app, page } = ctx;
      const before = await ledgerRows();
      const grown = await growCompactableSession(ctx);
      await startCompaction(ctx);
      const final = await waitCompactionDone(ctx);
      if (final !== "上下文已压缩") throw new Error(`压缩没有成功结束：${final}`);
      const afterCompact = await ledgerRows();

      await reloadIntoSession(ctx, { shortId: grown.shortId, keyword: grown.nonce });
      await expect(page.getByText(new RegExp(`第二份接口清单（编号 ${grown.nonce}）`)).first()).toBeVisible({ timeout: 15000 });
      await app.sleep(1500);
      const badges = await unsentBadges(page).count();
      const text = await mainText(page);
      await ctx.shot("EC4-重开会话");
      if (badges) throw new Error(`重开会话后出现 ${badges} 个「未送达」徽标`);
      if (before !== null && afterCompact !== null && before !== afterCompact) {
        throw new Error(`账本行数变了：压缩前 ${before}，压缩后 ${afterCompact}`);
      }
      return { ...grown, 结束状态: final, 账本行数: { 压缩前: before, 压缩后: afterCompact, 重开后: await ledgerRows() }, 未送达徽标: badges };
    },
  },
  {
    id: "EC-5",
    name: "压缩中点停止生效",
    feature: "压缩中停止送达引擎 / 取消按「已取消」收口",
    steps: "新会话发一条很长的接口清单和一条短消息 → /compact 发送 → 出现「压缩中」后立刻点停止",
    expect: "分隔线变成「上下文压缩已取消」；没有「压缩失败」弹窗；停止钮退场",
    needs: "model",
    timeoutMs: 900000,
    run: async (ctx) => {
      const { app, page } = ctx;
      const grown = await growCompactableSession(ctx);
      await startCompaction(ctx);
      await stopBtn(page).click();
      const deadline = Date.now() + 30000;
      let final = "";
      while (Date.now() < deadline) {
        final = ((await divider(page).textContent().catch(() => "")) || "").trim();
        if (TERMINAL.test(final)) break;
        await app.sleep(300);
      }
      await ctx.shot("EC5-停止后");
      if (final === "上下文已压缩") throw new Error("点停止时压缩已经完成（没赶上压缩进行中的窗口）");
      if (final !== "上下文压缩已取消") throw new Error(`停止后分隔线不是「已取消」而是「${final || "(无)"}」`);
      if (await failedDialog(page).first().isVisible().catch(() => false)) throw new Error("取消压缩却弹出了「压缩失败」");
      if (await stopBtn(page).isVisible().catch(() => false)) throw new Error("停止后停止钮仍在");
      const logs = await devLogs(app);
      const cancelled = logs.some((e) => /上下文压缩结束（引擎事件）/.test(e.message) && e.data?.aborted === true);
      return { ...grown, 结束状态: final, 失败弹窗: false, 引擎报告已取消: cancelled };
    },
  },
  {
    id: "EC-6",
    name: "压缩中暂存的消息在压缩结束后自动发出",
    feature: "暂存投递（需求7 补充轮：压缩结束 = 引擎空闲）",
    steps: "新会话发一条很长的接口清单和一条短消息 → /compact 发送 → 压缩进行中再发一条「只回复收到」→ 等全部结束",
    expect: "这条消息先进入暂存区；压缩结束后自动发出并得到回复",
    needs: "model",
    timeoutMs: 900000,
    run: async (ctx) => {
      const { app, page } = ctx;
      const grown = await growCompactableSession(ctx);
      const MARK = `压缩完成后只回复两个字：收到（${grown.nonce}）`;
      await startCompaction(ctx);
      await app.send(MARK);
      const staged = await app.stagedGrips().first().waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
      if (!staged) {
        // 压缩结束得比发送还快：消息被直接发出去了——没测到「压缩中暂存」
        await waitCompactionDone(ctx).catch(() => {});
        await app.waitIdle(4000, 300000);
        ctx.skip("压缩结束得太快，这条消息没赶上暂存（被直接发送）");
      }
      await ctx.shot("EC6-压缩中暂存");
      const final = await waitCompactionDone(ctx);
      const idle = await app.waitIdle(6000, 420000);
      const truth = await ctx.truth(ctx.since);
      const seq = truth?.sequence ?? [];
      const at = seq.findIndex((m) => m.role === "user" && m.text.includes("压缩完成后只回复两个字"));
      const reply = at >= 0 ? seq.slice(at + 1).find((m) => m.role === "assistant" && m.text) : null;
      await ctx.shot("EC6-压缩后自动发出");
      if (!reply) throw new Error(`暂存的消息没有得到回复（落盘序列：${JSON.stringify(seq.slice(-6))}）`);
      if (await app.stagedGrips().count()) throw new Error("回合都结束了，暂存区里还留着这条消息");
      return { ...grown, 暂存认定: staged, 压缩结束状态: final, 全部空闲: idle.idle, 自动发出的消息: MARK, 回复: reply.text.slice(0, 20) };
    },
  },
  {
    id: "EC-7",
    name: "压缩进行中「立即压缩」按钮为禁用态",
    feature: "一致性（/compact 与水位圆环里的「立即压缩」同一入口）",
    steps: "新会话发一条很长的接口清单和一条短消息 → /compact 发送 → 压缩进行中点开水位圆环",
    expect: "弹层里的按钮是禁用态、文字为「压缩中…」；点不出第二次压缩",
    needs: "model",
    timeoutMs: 900000,
    run: async (ctx) => {
      const { app, page } = ctx;
      const grown = await growCompactableSession(ctx);
      await startCompaction(ctx);
      await ringTrigger(page).click();
      const button = page.getByRole("button", { name: /^(立即压缩|压缩中)/ }).first();
      await expect(button).toBeVisible({ timeout: 8000 });
      const label = (await button.textContent()).trim();
      const disabled = await button.isDisabled();
      await ctx.shot("EC7-压缩中按钮禁用");
      await app.dismiss();
      const final = await waitCompactionDone(ctx);
      // 本会话（本轮开始之后）只应有一次压缩请求、一次压缩开始
      const since = await devLogs(app);
      const requests = since.filter((e) => e.ts >= ctx.since && /压缩请求已发给引擎/.test(e.message)).length;
      const starts = since.filter((e) => e.ts >= ctx.since && /上下文压缩开始（引擎事件）/.test(e.message)).length;
      if (!disabled || !/压缩中/.test(label)) throw new Error(`压缩进行中按钮应为禁用态「压缩中…」，实际：「${label}」disabled=${disabled}`);
      if (requests !== 1 || starts !== 1) throw new Error(`本会话应只有 1 次压缩请求、1 次压缩开始，实际 ${requests} 次 / ${starts} 次`);
      return { ...grown, 按钮文字: label, 禁用: disabled, 压缩请求次数: requests, 压缩开始次数: starts, 结束状态: final };
    },
  },
  {
    id: "EC-8",
    name: "带补充要求的压缩",
    feature: "参数透传（/compact 后面的文字作为摘要指令）",
    steps: "新会话发一条很长的接口清单和一条短消息 → 发送「/compact 摘要必须保留这一句：…」→ 等完成",
    expect: "压缩完成；日志里压缩请求带着这句补充要求",
    needs: "model",
    timeoutMs: 900000,
    run: async (ctx) => {
      const { app } = ctx;
      const grown = await growCompactableSession(ctx);
      const INSTRUCTION = "摘要必须保留这一句：接口清单用于回归验证";
      await startCompaction(ctx, `/compact ${INSTRUCTION}`);
      const final = await waitCompactionDone(ctx);
      await ctx.shot("EC8-带补充要求压缩完成");
      if (final !== "上下文已压缩") throw new Error(`压缩没有成功结束：${final}`);
      const logs = await devLogs(app);
      const ipc = logs.find((e) => /手动压缩会话/.test(e.message) && e.data?.customInstructions === INSTRUCTION);
      const sent = logs.find((e) => /压缩请求已发给引擎/.test(e.message) && e.data?.custom_instructions === true);
      if (!ipc || !sent) throw new Error("补充要求没有传到压缩请求: " + JSON.stringify(compactRequests(logs).slice(-2)));
      return { ...grown, 补充要求: INSTRUCTION, 结束状态: final };
    },
  },
  {
    id: "EC-9",
    name: "/name 标题 直接改名",
    feature: "参数透传（hub 内建命令在发送时本地执行）",
    steps: "新对话发一条短消息建会话 → 发送「/name 新标题」",
    expect: "会话头与侧栏标题变成新标题；这条命令不作为消息发出",
    needs: "model",
    timeoutMs: 180000,
    run: async (ctx) => {
      const { app, page } = ctx;
      if (ctx.state.modelOk === false) ctx.skip("模型不可用（本轮已判定）");
      await begin(ctx);
      const nonce = String(Date.now()).slice(-6);
      await app.send(`只回复两个字：收到（改名验证-${nonce}）`);
      await expectTurnStarted(ctx, "建会话的消息");
      await finishTurn(ctx);
      const headBefore = await app.sessionHeader();
      const name = `压缩验证会话-${nonce}`;
      await app.type(`/name ${name}`);
      await app.composer().press("Enter");
      await ctx.app.waitFor(name, 8000);
      const head = await app.sessionHeader();
      await app.sleep(1000);
      await ctx.shot("EC9-改名");
      if (head?.title !== name) throw new Error(`会话头标题不是新标题：${JSON.stringify(head)}`);
      const truth = await ctx.truth(ctx.since);
      if ((truth?.users ?? []).some((u) => u.includes(`/name ${name}`))) throw new Error("/name 被当成消息发给了智能体");
      if ((await page.getByRole("dialog").first().isVisible().catch(() => false))) throw new Error("带标题的 /name 不应打开改名对话框");
      return { 会话头短id: headBefore?.id, 新标题: name, 会话头: head?.title, 作为消息发出: false };
    },
  },
];
