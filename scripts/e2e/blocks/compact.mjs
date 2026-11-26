/**
 * 积木：v0.9.8 需求7 补充轮——斜杠命令与上下文压缩（EC-1~EC-13）。
 * 对应需求7 补充轮文档 docs/v0.9.8/需求7-加号引用菜单聚合/06-补充轮-斜杠命令与压缩.md；
 * 评审修复轮 R2 对 EC-10、EC-11 的改动见 docs/v0.9.8/评审修复轮-R2/tests/E-用例清单.md 第四节。
 * 用户原话：「我用/命令，我没有点发送，只是选择了compact这个命令就自动发送了，这是不对的，
 * 应该点了之后只是落到输入框，只有点击发送才发送」。
 *
 * 与其他积木文件不同的几点：
 * - 压缩要求会话「够大」，而且要大对形状：引擎从最新往回累加，攒够「保留近期内容」的
 *   预算（默认 2 万 token）才落切点，切点之前的历史才会被摘要——所以一条大消息不够
 *   （它自己就超预算，整条被保留，引擎报「没有可压缩的内容」），要先发一条、再发一条：
 *   后一条连同它的回复被保留，前一条被摘要。每条需要压缩的用例因此往新会话发两条各约
 *   9 万字符的「接口清单」（按引擎「4 字符 ≈ 1 token」的估算各约 2.3 万 token）——
 *   会占用模型用量，也会在当前项目留下测试会话（每块自己新建，留在项目里不删）。
 * - EC-5 会真的取消一次压缩；其余用例的压缩都会跑完。各用例各用自己的会话。
 * - EC-10、EC-11 压缩请求发生在**回合进行中**（用户原始场景「任务输出过程中执行 /compact」）。
 *   评审修复轮 R2（裁决 4：压缩和普通消息等价处理）之后，回合进行中发的 /compact 进待发送区，
 *   轮到它且引擎空闲时才执行——正在输出的那条跑到自然结束、不被中止；EC-11 另在它前面排一条消息。
 * - EC-12、EC-13 发智能体侧的斜杠命令（技能命令 / 只读的扩展命令），看未送达账本和会话状态。
 *
 * 等回合一律用框架默认值（不替用户表态）：本文件的提示词都不让模型调用工具，不会弹审批卡；
 * 真弹了，用例会失败并写明是哪一张（见 lib-pw.mjs 文件头）。
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
/** 引擎在压缩期间拒收消息时的原话（出现即说明有消息在压缩进行中被发了出去）。 */
const ERROR_PATTERN = /Cannot submit a prompt while compaction/i;
/**
 * 回合进行中压缩那两条用例（EC-10、EC-11）的慢消息：要写得够长，长到「等它开始输出 → 排一条消息 →
 * 发 /compact」这几步做完它还在输出；又不能太长——评审修复轮 R2 之后压缩不再中止当前任务，这条回合
 * 要跑到自然结束（原来是「不少于 6000 字」：那时压缩会把它掐掉，写得长不费时间；现在写长了只是多花
 * 时间和用量）。
 * 不能用「数到 N」——快模型几秒就数完，数大了它又会反问「输出太长你选哪种」直接结束（两种都实测遇到过）。
 * 4000 字（收口轮从 2500 字调上来）：开发模式下每次界面操作要一两秒，2500 字的回合在排完两条消息之前就结束了。
 */
const TURN_STORY =
  "不要调用任何工具，不要向我提问，不要解释或说明任何限制，直接开始并一直写到结束：写一篇连贯的故事，不少于 4000 字，分 16 段，每段至少 250 字，中间不要停。";
/** 「正在输出的那条跑到了结束」的判别线：它落盘的文字不少于这么多字（被压缩掐在半路的只有几百字）。 */
const STORY_MIN_CHARS = 1500;

/**
 * 等正在输出的回合真的在往外吐内容：停止钮亮着，且页面文字比上一次采样长了一段。
 * 流式气泡不在消息列表容器里（回放的消息才在里面），所以量整页文字。超时返回 false。
 * 输出一开始就认定，不等「连续两次变长」：开发模式下每次采样要一两秒，多等一轮就少一截
 * 可以排队的回合（收口轮实跑：EC-11 的一条排队消息因此没赶上）。
 */
async function waitOutputFlowing(ctx) {
  const { app, page } = ctx;
  const stop = stopBtn(page);
  const deadline = Date.now() + 90000;
  let last = -1;
  while (Date.now() < deadline) {
    if (await stop.isVisible().catch(() => false)) {
      const len = await page.evaluate(() => (document.body.innerText || "").length);
      if (last >= 0 && len > last + 40) return true;
      last = len;
    }
    await app.sleep(300);
  }
  return false;
}

/**
 * 一组只读的扩展命令（只查看、不改任何东西）——EC-13 从里头挑环境里有的第一条。
 * 它们由智能体侧的扩展直接处理，不触发回合。
 */
const READ_ONLY_COMMANDS = ["/todos", "/subagents-doctor", "/subagents-profiles", "/subagents-models", "/lens-health", "/lens-tools"];
/**
 * 输入「/」打开命令面板，读出里面的命令名，取第一条匹配 pattern 的（没有返回 null）；读完关掉面板、清空输入框。
 */
async function firstSlashCommand(ctx, pattern) {
  const { app, page } = ctx;
  await app.type("/");
  await app.sleep(800);
  const commands = await page.evaluate(() =>
    [...document.querySelectorAll("span.font-mono")].map((s) => (s.textContent || "").trim()).filter((t) => t.startsWith("/")),
  );
  await page.keyboard.press("Escape");
  await app.composer().fill("").catch(() => {});
  await expect(app.composer()).toHaveValue("");
  return commands.find((c) => pattern.test(c)) ?? null;
}

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
  // approvals 用默认值（不表态）：本文件的提示词都不让模型调用工具，回合里不该出现审批卡
  const turn = await app.waitTurn({ budgetMs: budget });
  if (!turn.done) throw new Error("回合未在时限内结束");
  const idle = await app.waitIdle(4000, budget);
  if (!idle.idle) throw new Error("回合结束后未进入空闲");
}

/** 模型可用性探测：发送后等回合启动的迹象（见驱动库 awaitTurnStart）。不可用就标记并跳过。
 *  text：不是经 send 发出的消息，把它的文字传进来（按内容认「刚发的那条」）。 */
async function expectTurnStarted(ctx, what, text = "") {
  const { app } = ctx;
  const started = await app.awaitTurnStart(20000, text ? { text } : {});
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
  await expectTurnStarted(ctx, "第二条接口清单", `下面是第二份接口清单（编号 ${nonce}）`);
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

/**
 * 「未送达」账本的行数（~/.jishu-hub/pending_messages.db）。返回 { rows, reason }。
 * 读不到时 rows 为 null、reason 写明是哪种情况：运行环境的 Node 没有 node:sqlite（需要 22.5 以上）、
 * 或者被别的进程占着——调用方靠 ledgerUnchanged 把「没核对」明确报出来，不再静默跳过那条断言
 *（评审修复轮 R2：原来读不到就返回 null，用例里的账本断言无声地少了一条）。
 */
async function ledgerRows() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(os.homedir(), ".jishu-hub", "pending_messages.db"), { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS n FROM pending_user_messages").get();
    db.close();
    return { rows: Number(row.n), reason: "" };
  } catch (e) {
    const message = String(e?.message || e);
    if (/ENOENT|no such file|找不到/i.test(message)) return { rows: 0, reason: "账本文件还不存在（这台机器上还没有过未送达的消息，按 0 行算）" };
    if (/node:sqlite|built-in module|No such built-in/i.test(message)) {
      return { rows: null, reason: `当前 Node（${process.version}）没有 node:sqlite 模块（需要 22.5 以上）` };
    }
    return { rows: null, reason: `读账本失败：${message.slice(0, 120)}` };
  }
}

/**
 * 账本行数前后要一致（发了一条不该留账的消息之后，没有多出销不掉的行）。
 * 有一边读不到就不下结论：在结果里标「未核对」并写明原因，其余断言照常。
 */
function ledgerUnchanged(ctx, before, after, what) {
  if (before.rows === null || after.rows === null) {
    ctx.warn(`${what}的账本行数没有核对——${before.reason || after.reason}`);
    return;
  }
  if (before.rows !== after.rows) throw new Error(`${what}账本行数变了：${before.rows} → ${after.rows}`);
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
  // 引擎也会把「没有可压缩的内容」直接写在分隔线上（上下文压缩失败）——同样是前提不成立
  const firstText = ((await divider(page).textContent().catch(() => "")) || "").trim();
  if (/压缩失败/.test(firstText)) ctx.skip(`会话不可压缩（前提不成立）：${firstText.slice(0, 120)}`);
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

/**
 * 回合进行中请求压缩（评审修复轮 R2 / 裁决 4：压缩和普通消息等价处理——进待发送区，轮到它且引擎
 * 空闲时才执行）。EC-10、EC-11 共用：
 * 1. 发一条要写故事的慢消息，等它真的在往外吐内容；
 * 2.（mark 给了才做）回合进行中先排一条普通消息——它排在压缩前面；
 * 3. 回合还在进行时发 /compact：必须进待发送区、不立即执行（回合结束前不出现压缩分隔线）；
 *    （afterMark 给了才做）紧接着再排一条普通消息——它排在压缩后面，压缩结束后才发出；
 * 4. 等队列排完：正在输出的那条跑到结束 →（排队的消息发出并得到回复）→ 压缩才执行；
 *    压缩分隔线出现的那一刻，排在压缩前面的必须都已经发出（afterMark 排上了时待发送区恰好剩它一条）；
 * 5. 读会话落盘，核对先后顺序与「正在输出的那条没被中止」。
 * 前提不成立（回合结束得太快、会话不可压缩）在这里标跳过；行为不对直接抛错。
 * 返回 { storyMark, stagedOrder, stagedAll, afterQueued, stagedWhenStarted, final, idle, truth, storyAt, endAt, compactionAt, storyChars, 有报错, 暂存区剩余 }。
 */
async function compactDuringTurn(ctx, grown, { mark = null, afterMark = null } = {}) {
  const { app, page } = ctx;
  const id = mark ? "EC11" : "EC10";
  const storyMark = `任务输出过程中压缩-${grown.nonce}`;
  const running = () => stopBtn(page).isVisible().catch(() => false);
  const drain = () => app.waitIdle(4000, 300000).catch(() => {});
  await app.send(`${storyMark}\n${TURN_STORY}`);
  await expectTurnStarted(ctx, "慢消息");
  await waitOutputFlowing(ctx);
  if (mark) {
    await app.send(mark);
    const stagedMark = await app.stagedGrips().first().waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
    if (!stagedMark) {
      await drain();
      ctx.skip("回合结束得太快，这条消息没赶上排队（被直接发送了）——没测到「压缩排在它后面」");
    }
  }
  if (!(await running())) {
    await drain();
    ctx.skip(mark ? "排队的消息进去了，但回合已经结束，没赶上「任务输出过程中」压缩" : "回合已经结束，没赶上「任务输出过程中」压缩");
  }
  // 这次请求的压缩的分隔线：会话里可能留着以前压缩的分隔线，按条数认出新的那一条
  const dividersBefore = await page.locator('[data-phase="compaction"]').count();
  const mine = page.locator('[data-phase="compaction"]').nth(dividersBefore);
  const dividerText = async () => ((await mine.textContent().catch(() => "")) || "").trim();

  // 回合进行中发 /compact → 进待发送区。按回车发，不点发送钮：点之前要等它「稳定、可点」，
  // 输出期间页面忙，一等十几秒，回合可能已经结束了（收口轮实跑：EC-10 因此把「回合已结束、
  // 压缩按空闲路径立即执行」报成了产品问题——那时亮着的停止钮是压缩自己的）。
  await app.type("/compact ");
  await app.composer().press("Enter");
  await expect(app.composer()).toHaveValue("", { timeout: 5000 });
  const queued = await app.stagedGrips().first().waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
  if (!queued) {
    const early = await dividerText();
    await drain();
    // 没排上：按落盘事实分清两种情况。正在输出的那条跑到了结束 = 发 /compact 时回合已经结束，
    // 压缩按空闲时的路径立即执行（前提不成立）；没跑到结束 = 回合还在输出就被压缩中止（产品问题）
    const truth = await ctx.truth(ctx.since).catch(() => null);
    const tl = truth?.timeline ?? [];
    const storyRow = tl.findIndex((m) => m.role === "user" && m.text.includes(storyMark));
    const endRow = tl.findIndex((m, i) => i > storyRow && (m.role === "user" || m.role === "compaction"));
    const storyChars = (truth?.assistantLengths ?? []).reduce(
      (sum, n, k) => sum + (truth.assistantAt[k] > storyRow && truth.assistantAt[k] < endRow ? n : 0),
      0,
    );
    if (storyChars >= STORY_MIN_CHARS) {
      ctx.skip(`发 /compact 的时候这条慢消息的回合已经结束（落盘 ${storyChars} 字，跑到了结束），压缩按空闲时的路径立即执行——没赶上「任务输出过程中」${early ? `（分隔线：「${early}」）` : ""}`);
    }
    throw new Error(
      `回合进行中发的 /compact 没有进待发送区${early ? `，而是立即执行了（分隔线：「${early}」）` : "，也没看到压缩分隔线"}——正在输出的那条只落盘 ${storyChars} 字，像是被压缩中止了（修前表现）`,
    );
  }
  await ctx.shot(`${id}-回合进行中`);
  const stagedOrder = await app.stagedTexts();
  const dividerNow = await dividerText();
  if (/压缩中/.test(dividerNow)) throw new Error(`回合还在输出，压缩就已经开始了（分隔线「${dividerNow}」）——排队的压缩不该立即执行`);
  if (!(await running())) {
    await drain();
    ctx.skip("发完 /compact 回合立刻就结束了，量不出「回合结束前压缩没有执行」");
  }

  //（afterMark 给了才做）/compact 进了待发送区之后，再排一条普通消息——它排在压缩后面，
  // 要等压缩结束才发出。没赶上排队（回合已结束、消息被直接发出）时 afterQueued 记 false，
  // 调用方据此不核对「排在压缩后面」，并如实写明。
  let afterQueued = false;
  let stagedAll = stagedOrder;
  if (afterMark && (await running())) {
    await app.send(afterMark);
    stagedAll = await app.stagedTexts();
    afterQueued =
      stagedAll.length === stagedOrder.length + 1 &&
      stagedAll.slice(0, stagedOrder.length).every((text, k) => text === stagedOrder[k]) &&
      stagedAll[stagedAll.length - 1].includes("压缩后面排队的消息");
  }

  // 等队列排到压缩；记下分隔线出现的那一刻待发送区还剩几条。
  // 排队路径里压缩失败不落在分隔线上，而是弹「压缩失败」窗（页面的压缩执行器 catch 之后弹窗、乐观分隔线撤掉）——
  // 只盯分隔线会一直等下去，所以每一轮也看一眼弹窗。
  let stagedWhenStarted = null;
  let final = "";
  const deadline = Date.now() + 900000;
  while (Date.now() < deadline) {
    const text = await dividerText();
    if (text && stagedWhenStarted === null) {
      stagedWhenStarted = await app.stagedGrips().count();
      await ctx.shot(`${id}-压缩开始执行`);
    }
    if (TERMINAL.test(text)) {
      final = text;
      break;
    }
    if (await failedDialog(page).first().isVisible().catch(() => false)) {
      final = `弹窗：${((await failedDialog(page).first().textContent()) || "").replace(/\s+/g, " ").trim()}`;
      await ctx.shot(`${id}-压缩失败弹窗`);
      await app.cancelResidualDialog();
      break;
    }
    await app.sleep(500);
  }
  if (!final) throw new Error("排队的压缩在 15 分钟内没有执行完（分隔线一直没出现，或一直停在「压缩中」）");
  // 排队的压缩失败：原因写在「压缩失败」弹窗上（分隔线只有「上下文压缩失败」几个字）。读出来、点掉它，
  // 之后的断言与跳过都带着原因。首跑实跑踩到：分隔线先到了终态，循环没走到看弹窗的那一步，
  // 原因没读到，「会话内容还不多」被当成了产品问题继续往下跑
  let failedText = /弹窗/.test(final) ? final : "";
  if (/失败/.test(final) && !failedText) {
    const dlg = failedDialog(page).first();
    if (await dlg.isVisible().catch(() => false)) {
      failedText = `弹窗：${((await dlg.textContent()) || "").replace(/\s+/g, " ").trim()}`;
    }
  }
  if (failedText) {
    await ctx.shot(`${id}-压缩失败`);
    const ok = failedDialog(page).first().getByRole("button", { name: "知道了" });
    if (await ok.isVisible().catch(() => false)) await ok.click();
  }
  // 「没有可压缩的内容」是前提不成立；别的失败是产品问题，交给调用方按「没有正常结束」报错
  if (failedText && /没有可压缩|还不多|不需要压缩|nothing to compress|too small|not enough/i.test(failedText)) {
    ctx.skip(`会话不可压缩（前提不成立）：${failedText.slice(0, 120)}`);
  }
  const idle = await app.waitIdle(6000, 420000);

  // 落盘：先后顺序、正在输出的那条写了多少字
  const truth = await ctx.truth(ctx.since);
  const tl = truth?.timeline ?? [];
  const storyAt = tl.findIndex((m) => m.role === "user" && m.text.includes(storyMark));
  const endAt = tl.findIndex((m, i) => i > storyAt && (m.role === "user" || m.role === "compaction"));
  const compactionAt = tl.findIndex((m, i) => i > storyAt && m.role === "compaction");
  const lengths = truth?.assistantLengths ?? [];
  const at = truth?.assistantAt ?? [];
  const storyChars = lengths.reduce((sum, n, k) => sum + (at[k] > storyAt && at[k] < endAt ? n : 0), 0);
  return {
    storyMark,
    stagedOrder,
    stagedAll,
    afterQueued,
    stagedWhenStarted,
    final,
    idle,
    truth,
    storyAt,
    endAt,
    compactionAt,
    storyChars,
    有报错: ERROR_PATTERN.test(await mainText(page)),
    暂存区剩余: await app.stagedGrips().count(),
  };
}

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
      if (badges) throw new Error(`重开后出现 ${badges} 个「未送达」徽标`);
      ledgerUnchanged(ctx, before, afterCompact, "压缩前后");
      return {
        ...grown,
        结束状态: final,
        账本行数: { 压缩前: before.rows, 压缩后: afterCompact.rows, 重开后: (await ledgerRows()).rows },
        未送达徽标: badges,
      };
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
  {
    id: "EC-10",
    name: "任务输出过程中压缩（没有排队的消息）：/compact 进待发送区，回合结束才执行",
    feature: "压缩排队 × 回合进行中（评审 R2-4 / 裁决 4：压缩和普通消息等价处理）",
    steps: "新发两条很长的接口清单（自己造一个可压缩的会话——别的用例留下的会话都已被压缩过，再压不动）→ 再发一条要写长篇故事的慢消息，等它开始输出 → 回合还在进行时发送 /compact → 看它进待发送区 → 等回合自然结束、压缩执行完 → 再发一条短消息",
    expect: "回合进行中发的 /compact 进了待发送区、没有立即执行（回合结束前没有出现压缩分隔线，正在输出的那条跑到结束、没有被中止）；回合结束后压缩才执行并显示「上下文已压缩」；会话里没有报错；之后还能正常对话",
    needs: "model",
    timeoutMs: 900000,
    run: async (ctx) => {
      const { app } = ctx;
      const grown = await growCompactableSession(ctx);
      const r = await compactDuringTurn(ctx, grown);
      await ctx.shot("EC10-压缩结束之后");
      const FOLLOW = `压缩之后只回复两个字：收到（${grown.nonce}）`;
      await app.send(FOLLOW);
      await expectTurnStarted(ctx, "压缩后的短消息");
      await finishTurn(ctx, 300000);
      const truth = await ctx.truth(ctx.since);
      const seq = truth?.sequence ?? [];
      const at = seq.findIndex((m) => m.role === "user" && m.text.includes("压缩之后只回复两个字"));
      const reply = at >= 0 ? seq.slice(at + 1).find((m) => m.role === "assistant" && m.text) : null;
      const facts = {
        ...grown,
        排队时待发送区: r.stagedOrder,
        压缩开始时待发送区剩余: r.stagedWhenStarted,
        正在输出的那条写了多少字: r.storyChars,
        压缩结束状态: r.final,
        全部空闲: r.idle.idle,
        有报错: r.有报错,
        压缩后短消息的回复: reply ? reply.text.slice(0, 20) : null,
      };
      const onlyCompact = r.stagedOrder.length === 1 && /^\s*\/compact\b/.test(r.stagedOrder[0]);
      if (!onlyCompact) throw new Error(`回合进行中发的 /compact 应当作为一条排队消息进待发送区，实际待发送区是 ${JSON.stringify(r.stagedOrder)}：${JSON.stringify(facts)}`);
      if (r.stagedWhenStarted !== 0) throw new Error(`压缩开始执行时待发送区里还剩 ${r.stagedWhenStarted} 条：${JSON.stringify(facts)}`);
      if (!/上下文已压缩/.test(r.final)) throw new Error(`排队的压缩没有正常结束：${JSON.stringify(facts)}`);
      if (r.storyChars < STORY_MIN_CHARS) {
        throw new Error(
          `回合进行中发 /compact 之后，正在输出的那条没有跑到结束（落盘 ${r.storyChars} 字，少于 ${STORY_MIN_CHARS}）——像是被压缩中止了：${JSON.stringify(facts)}`,
        );
      }
      if (facts.有报错) throw new Error(`任务输出过程中压缩，会话里出现了报错：${JSON.stringify(facts)}`);
      if (!r.idle.idle) throw new Error(`全部结束之后会话没有进入空闲：${JSON.stringify(facts)}`);
      if (!reply) throw new Error(`压缩之后发的消息没有得到回复：${JSON.stringify(facts)}`);
      return facts;
    },
  },
  {
    id: "EC-11",
    name: "任务输出过程中压缩：/compact 排在已排队的消息后面，按顺序执行",
    feature: "压缩排队 × 待发送区（裁决 4：轮到它且引擎空闲时才执行）",
    steps: "新发两条很长的接口清单 → 再发一条要写长篇故事的慢消息，等它开始输出 → 回合进行中先排一条「只回复收到」→ 回合还在进行时发送 /compact → 再排一条「压缩后面排队的消息」→ 看待发送区里的顺序 → 等全部结束 → 读会话落盘的先后顺序",
    expect: "待发送区里排队的消息在前、/compact 在后、压缩后面排的那条在最后；正在输出的那条跑到结束、没有被中止；两条排队的消息各只发出一次并得到回复，压缩后面那条在压缩结束之后才发出；压缩在第一条排队的消息得到回复之后才执行并显示「上下文已压缩」；压缩开始时待发送区里只剩压缩后面那一条（它没赶上排队时为空）；会话里没有报错；全部结束后待发送区为空",
    needs: "model",
    timeoutMs: 900000,
    run: async (ctx) => {
      const grown = await growCompactableSession(ctx);
      const MARK = `任务输出过程中排队的消息：只回复两个字：收到（${grown.nonce}）`;
      const AFTER = `压缩后面排队的消息：只回复两个字：好的（${grown.nonce}）`;
      const r = await compactDuringTurn(ctx, grown, { mark: MARK, afterMark: AFTER });
      await ctx.shot("EC11-压缩结束之后");
      const tl = r.truth?.timeline ?? [];
      const seq = r.truth?.sequence ?? [];
      const queuedRows = seq.filter((m) => m.role === "user" && m.text.includes("任务输出过程中排队的消息"));
      const afterRows = seq.filter((m) => m.role === "user" && m.text.includes("压缩后面排队的消息"));
      const replyAt = tl.findIndex((m, i) => i > r.endAt && m.role === "assistant" && m.text);
      // 压缩后面那条：落盘位置、它之后的回复
      const afterAt = tl.findIndex((m) => m.role === "user" && m.text.includes("压缩后面排队的消息"));
      const afterReplyAt = tl.findIndex((m, i) => i > afterAt && afterAt >= 0 && m.role === "assistant" && m.text);
      const facts = {
        ...grown,
        排队时待发送区的顺序: r.stagedAll,
        压缩后面那条赶上了排队: r.afterQueued,
        压缩开始时待发送区剩余: r.stagedWhenStarted,
        正在输出的那条写了多少字: r.storyChars,
        压缩结束状态: r.final,
        全部空闲: r.idle.idle,
        有报错: r.有报错,
        排队的消息落盘次数: queuedRows.length,
        排队的消息得到回复: replyAt >= 0,
        压缩后面那条落盘次数: afterRows.length,
        压缩后面那条得到回复: afterReplyAt >= 0,
        落盘顺序: tl.slice(Math.max(0, r.storyAt)).map((m) => `${m.role}:${m.text.slice(0, 16)}`),
      };
      const firstTwo = r.stagedOrder.length >= 2 && r.stagedOrder[0].includes("任务输出过程中排队的消息") && /^\s*\/compact\b/.test(r.stagedOrder[1]);
      if (!firstTwo) throw new Error(`待发送区里的顺序应当是「排队的消息在前、/compact 在后」，实际是 ${JSON.stringify(r.stagedOrder)}：${JSON.stringify(facts)}`);
      if (!r.afterQueued) {
        ctx.warn("压缩后面那条没赶上排队（回合已经结束，它被直接发出）——「排在压缩后面、压缩结束才发出」这一段没有测到");
      }
      // 压缩后面那条排上了队（出现在某一次待发送区的读数里）——它只该在压缩结束之后发出
      const afterStaged = r.afterQueued || r.stagedAll.some((text) => text.includes("压缩后面排队的消息"));
      // 压缩开始时：排在它前面的都已发出；压缩后面那条排上了时待发送区里至多剩它一条。
      // 不要求「恰好」：回合结束、排队的消息得到回复，可能都发生在两次读数之间，压缩后面那条
      // 排上时压缩已经开始了（收口轮在安装包上实跑：落盘顺序完全正确，读数却差了一拍）
      const maxLeft = afterStaged ? 1 : 0;
      if (r.stagedWhenStarted === null || r.stagedWhenStarted > maxLeft) {
        throw new Error(`压缩开始执行时待发送区里应当${maxLeft ? "至多只剩压缩后面那一条" : "已经空了"}，实际剩 ${r.stagedWhenStarted} 条：${JSON.stringify(facts)}`);
      }
      if (r.storyChars < STORY_MIN_CHARS) {
        throw new Error(
          `回合进行中发 /compact 之后，正在输出的那条没有跑到结束（落盘 ${r.storyChars} 字，少于 ${STORY_MIN_CHARS}）——像是被压缩中止了：${JSON.stringify(facts)}`,
        );
      }
      if (r.endAt < 0 || !tl[r.endAt]?.text.includes("任务输出过程中排队的消息")) {
        throw new Error(`落盘里排队的消息没有紧接在正在输出的那条之后：${JSON.stringify(facts)}`);
      }
      if (queuedRows.length !== 1) throw new Error(`排队的消息应当只发出一次，实际落盘 ${queuedRows.length} 次：${JSON.stringify(facts)}`);
      if (replyAt < 0) throw new Error(`排队的消息没有得到回复：${JSON.stringify(facts)}`);
      if (r.compactionAt < 0) {
        ctx.warn("落盘里找不到这次压缩的边界（compaction 条目）——「压缩排在排队的消息之后」只由界面事实核对（压缩开始时待发送区已空）");
      } else if (r.compactionAt < replyAt) {
        throw new Error(`压缩在排队的消息得到回复之前就执行了：${JSON.stringify(facts)}`);
      }
      if (!/上下文已压缩/.test(r.final)) throw new Error(`排队的压缩没有正常结束：${JSON.stringify(facts)}`);
      if (facts.有报错) throw new Error(`任务输出过程中压缩，会话里出现了报错（排队的消息被提前发出、遭引擎拒收）：${JSON.stringify(facts)}`);
      if (r.暂存区剩余) throw new Error(`全部结束了，暂存区里还留着 ${r.暂存区剩余} 条：${JSON.stringify(facts)}`);
      if (!r.idle.idle) throw new Error(`全部结束之后会话没有进入空闲：${JSON.stringify(facts)}`);
      if (afterStaged) {
        if (r.compactionAt >= 0 && afterAt < r.compactionAt) {
          throw new Error(`压缩后面排的那条在压缩结束之前就发出了（压缩和普通消息应当等价处理、按顺序执行）：${JSON.stringify(facts)}`);
        }
        if (afterRows.length !== 1) throw new Error(`压缩后面排的那条应当只发出一次，实际落盘 ${afterRows.length} 次：${JSON.stringify(facts)}`);
        if (afterReplyAt < 0) throw new Error(`压缩后面排的那条没有得到回复：${JSON.stringify(facts)}`);
        // 待发送区的读数里它排在 /compact 后面（订正：原先比对的是「排队顺序」读数里的第 3 项，那一项并不存在；
        // 这段断言在此之前从没被走到过——安装包上实跑才第一次走到）
        const last = r.stagedAll[r.stagedAll.length - 1];
        const beforeLast = r.stagedAll[r.stagedAll.length - 2] ?? "";
        if (!last.includes("压缩后面排队的消息") || !/^\s*\/compact\b/.test(beforeLast)) {
          throw new Error(`压缩后面排的那条应当排在 /compact 之后，实际待发送区是 ${JSON.stringify(r.stagedAll)}：${JSON.stringify(facts)}`);
        }
      }
      return facts;
    },
  },
  {
    id: "EC-12",
    name: "发一条技能命令：执行了，重开会话不留「未送达」",
    feature: "斜杠命令 × 未送达账本（需求7 补充二：智能体侧的命令照常发给智能体）",
    steps: "新会话发一条短消息 → 输入「/」读面板，取第一条 /skill: 命令（环境里没有就跳过）→ 发送它 → 等回合结束 → 记账本行数 → 重载页面回到该会话",
    expect: "命令被执行（有回复或命令生效）；账本没有多出销不掉的行；重开后没有「未送达」徽标、正文里没有重复的命令消息",
    needs: "model",
    timeoutMs: 600000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await begin(ctx);
      const nonce = String(Date.now()).slice(-6);
      const OPEN = `斜杠命令验证：只回复两个字：收到（${nonce}）`;
      await app.send(OPEN);
      await expectTurnStarted(ctx, "建会话的消息");
      await finishTurn(ctx);
      const head = await app.sessionHeader();
      if (!head) throw new Error("读不到会话头");
      // 优先挑只做讲解、不会动手的技能命令；没有再取面板里第一条技能命令
      let skill = null;
      for (const name of ["/skill:jishu-cli-guide", "/skill:jishu-hub-capabilities", "/skill:find-skills"]) {
        skill = await firstSlashCommand(ctx, new RegExp(`^${name}$`));
        if (skill) break;
      }
      if (!skill) skill = await firstSlashCommand(ctx, /^\/skill:/);
      if (!skill) ctx.skip("当前环境的「/」面板里没有技能命令（前提不成立）");
      const before = await ledgerRows();
      await app.type(`${skill} `);
      await sendBtn(page).click();
      await expect(app.composer()).toHaveValue("", { timeout: 5000 });
      // 技能命令会展开成一段提示词、起一个回合；没起回合也算执行过了（如实记录）
      const started = await app.awaitTurnStart(30000);
      if (started) {
        // approvals 显式 false（与默认值相同）：技能展开后的提示词由技能决定，可能让模型调工具——
        // 框架不替用户放行；真弹了审批卡，这里会失败并写明是哪一张（断言本身不依赖工具执行）
        const turn = await app.waitTurn({ budgetMs: 240000, approvals: false });
        if (!turn.done) throw new Error("技能命令的回合没有在时限内结束");
        const idle = await app.waitIdle(4000, 240000);
        if (!idle.idle) throw new Error("技能命令的回合结束后没有进入空闲");
      }
      const afterSend = await ledgerRows();
      await ctx.shot("EC12-命令发出之后");
      await reloadIntoSession(ctx, { shortId: head.id, keyword: OPEN });
      await app.sleep(1500);
      const badges = await unsentBadges(page).count();
      const ghosts = await page.locator('[data-turn-scope="main"]').evaluate((el) => {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('[data-phase="compaction"]').forEach((n) => n.remove());
        return (clone.textContent || "").split("/skill:").length - 1;
      });
      await ctx.shot("EC12-重开会话");
      const reopened = await ledgerRows();
      const facts = {
        技能命令: skill,
        起了回合: started,
        账本行数: { 发送前: before.rows, 发送后: afterSend.rows, 重开后: reopened.rows },
        未送达徽标: badges,
        正文里的命令消息数: ghosts,
      };
      ledgerUnchanged(ctx, before, afterSend, "发技能命令前后");
      if (badges) throw new Error(`发一条技能命令后重开会话，出现 ${badges} 个「未送达」徽标：${JSON.stringify(facts)}`);
      return facts;
    },
  },
  {
    id: "EC-13",
    name: "发一条只读的扩展命令：会话不卡在「处理中」",
    feature: "斜杠命令 × 引擎命令响应（不触发回合的扩展命令）",
    steps: "新会话发一条短消息 → 输入「/」读面板，从一组只读的扩展命令里取环境里有的第一条（没有就跳过）→ 发送它 → 看「停止」钮多久退场 → 再发一条短消息，看多久得到回复",
    expect: "命令立即执行、不起回合：「停止」钮不出现，或在 2 秒内退场（会话不卡在处理中）；之后的消息正常得到回复；消息区里没有留下这条扩展命令的用户消息（用户消息行数 = 发命令前 + 1，多的那条是之后发的短消息）",
    needs: "model",
    timeoutMs: 600000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await begin(ctx);
      const nonce = String(Date.now()).slice(-6);
      await app.send(`扩展命令验证：只回复两个字：收到（${nonce}）`);
      await expectTurnStarted(ctx, "建会话的消息");
      await finishTurn(ctx);
      let command = null;
      for (const name of READ_ONLY_COMMANDS) {
        command = await firstSlashCommand(ctx, new RegExp(`^${name}$`));
        if (command) break;
      }
      if (!command) ctx.skip(`当前环境的「/」面板里没有这些只读扩展命令：${READ_ONLY_COMMANDS.join(" ")}`);
      // 消息区里的用户消息行（只有用户消息行带 data-turn-index）：扩展命令不该在里面留下一条
      const userRows = () => page.locator('[data-turn-scope="main"] [data-message-index][data-turn-index]').count();
      const usersBefore = await userRows();
      const t0 = Date.now();
      await app.type(`${command} `);
      await sendBtn(page).click();
      await expect(app.composer()).toHaveValue("", { timeout: 5000 });
      // 停止钮多久退场。评审修复轮 R2 之后（契约 C1）：引擎空闲时发扩展命令，界面为它乐观起一条流
      //（停止钮可能亮一下），引擎执行完回 Handled，这条流整条丢弃——不起回合、不留用户消息。
      // 所以停止钮不该出现，或者两秒内退场；一直不退 = 会话卡在「处理中」（修前表现）。
      let stopSeenAt = null;
      let stopGoneAt = null;
      const watch = Date.now() + 40000;
      while (Date.now() < watch) {
        const on = await stopBtn(page).isVisible().catch(() => false);
        const now = Date.now() - t0;
        if (on && stopSeenAt === null) stopSeenAt = now;
        if (!on && stopSeenAt !== null && stopGoneAt === null) {
          stopGoneAt = now;
          break;
        }
        if (!on && stopSeenAt === null && now > 8000) break; // 8 秒都没亮过：就是「不出现」
        await app.sleep(150);
      }
      const stopShownMs = stopSeenAt !== null && stopGoneAt !== null ? stopGoneAt - stopSeenAt : null;
      await ctx.shot("EC13-扩展命令之后");
      const t1 = Date.now();
      const FOLLOW = `扩展命令之后只回复两个字：收到（${nonce}）`;
      await app.send(FOLLOW);
      const started = await app.awaitTurnStart(30000);
      if (!started) throw new Error("扩展命令之后发的消息没有起回合");
      // approvals 显式 false（与默认值相同）：只读扩展命令自己处理、不起回合，不该有审批卡；真弹了用例会失败并写明
      const turn = await app.waitTurn({ budgetMs: 240000, approvals: false });
      const followMs = Date.now() - t1;
      const truth = await ctx.truth(ctx.since);
      const seq = truth?.sequence ?? [];
      const at = seq.findIndex((m) => m.role === "user" && m.text.includes("扩展命令之后只回复两个字"));
      const reply = at >= 0 ? seq.slice(at + 1).find((m) => m.role === "assistant" && m.text) : null;
      // 等界面落定再数：回合收口后那条短消息才从流式气泡并回消息列表
      await app.waitIdle(3000, 120000).catch(() => {});
      const usersAfter = await userRows();
      const facts = {
        扩展命令: command,
        停止钮出现于毫秒: stopSeenAt,
        停止钮退场于毫秒: stopGoneAt,
        停止钮亮了多久毫秒: stopShownMs,
        之后消息得到回复用时毫秒: followMs,
        回合结束: turn.done,
        有回复: Boolean(reply),
        消息区的用户消息行数: { 发命令前: usersBefore, 全部结束之后: usersAfter },
      };
      if (stopSeenAt !== null && stopGoneAt === null) {
        await app.waitIdle(4000, 120000).catch(() => {});
        throw new Error(`发一条不触发回合的扩展命令后，会话一直停在「处理中」（停止钮亮了 40 秒没退）：${JSON.stringify(facts)}`);
      }
      if (stopShownMs !== null && stopShownMs > 2000) {
        throw new Error(`发一条不触发回合的扩展命令后，停止钮 ${stopShownMs} 毫秒才退场（应在 2 秒内）：${JSON.stringify(facts)}`);
      }
      if (!turn.done || !reply) throw new Error(`扩展命令之后的消息没有得到正常回复：${JSON.stringify(facts)}`);
      // C1：引擎空闲时发扩展命令，这条流在回合结束（Handled）后丢弃，不留下用户气泡
      if (!usersBefore) ctx.warn("消息区里没找到用户消息行（data-turn-index）——扩展命令有没有留下用户气泡没有核对");
      else if (usersAfter !== usersBefore + 1) {
        throw new Error(`发一条扩展命令并得到下一条消息的回复之后，消息区的用户消息行数应是 ${usersBefore + 1}，实际 ${usersAfter}（扩展命令留下了用户气泡，或多出 / 少了消息）：${JSON.stringify(facts)}`);
      }
      return facts;
    },
  },
];
