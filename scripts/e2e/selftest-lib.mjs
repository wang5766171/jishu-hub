#!/usr/bin/env node
/**
 * selftest-lib.mjs —— 驱动库的离线自测：不连应用，用假的 Playwright 页面对象核对 lib-pw.mjs 里
 * 不依赖真实界面就能验的逻辑（v0.9.8 评审修复轮 R2 / 用户裁决 9）。
 *
 *   node scripts/e2e/selftest-lib.mjs
 *
 * 覆盖：
 * - 附着校验：调试口上的页面不是 jishu-hub（地址不是 tauri.localhost / 开发地址）→ 拒绝附着；
 * - 等回合的审批三态：默认不表态（有卡 → 按 Esc 拒绝、记日志、回合结束后抛错并写明卡上的命令）；
 *   "allow" 只点「仅本次允许」并报告点了几次、哪个钮，放行范围之外的卡点「拒绝」；"deny" 点「拒绝」；
 *   旧的默认值 true（自动放行）不再被接受；「始终允许」任何情况下都不点；
 * - 用例租约 forCase：超时（expire）后正在进行的轮询等待下一轮退出、之后的驱动调用立即抛错，新用例照常可用；
 *   用例视图里的 waitGraphRun 只传运行号时「是否还活着」放对参数位置（T13）。
 *
 * 这是「框架默认不放行」这条缺陷（评审 R2-9）的判别力对照：把 lib-pw.mjs 里 waitTurn 的默认值临时改回
 * 自动放行，T4 / T10 必红。实机上的对应用例是 approval 场景包的 AP-1 / AP-2 / AP-3。
 * T13 是「用例视图把参数放错位置」的对照：把 forCase 里的按位置放改回一律追加到末尾，T13 必红（立即返回空表）。
 * 假页面只实现 waitTurn / waitIdle / clickApproval / cancelResidualDialog / waitGraphRun / forCase 会碰到的那几个方法。
 */
import { chromium } from "playwright";

const results = [];
const brief = (r) => (r.ok ? "(没有抛错——本该抛的)" : String(r.message).slice(0, 80));
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** 假页面：只实现 waitTurn / waitIdle / clickApproval / forCase 会碰到的那几个方法。 */
function makeFake({ url, card = null, streaming = false }) {
  const state = { cardVisible: Boolean(card), card, clicked: [], keys: [], streaming };
  const locator = (kind, extra = {}) => {
    const api = {
      kind,
      filter: () => locator(kind, extra),
      first: () => locator(kind, extra),
      nth: () => locator(kind, extra),
      locator: (sel) => locator(`${kind}:${sel}`, extra),
      or: (other) => locator(kind, extra),
      count: async () => 0,
      isVisible: async () => (kind === "approvalDialogs" ? state.cardVisible : kind === "stop" ? state.streaming : false),
      textContent: async () => (kind === "approvalDialogs:pre" && state.card ? JSON.stringify(state.card.payload, null, 2) : ""),
      allTextContents: async () => (kind === "approvalButtons" && state.card ? state.card.buttons : []),
      all: async () => [],
      click: async () => {
        state.clicked.push(extra.name);
        state.cardVisible = false;
      },
      waitFor: async () => {},
      evaluate: async () => {},
      evaluateAll: async () => [],
    };
    return api;
  };
  const page = {
    url: () => url,
    setDefaultTimeout() {},
    on() {},
    locator: (sel) => locator(sel.includes("停止") ? "stop" : sel),
    getByRole: (role, opts = {}) => locator(role === "dialog" ? "approvalDialogs" : role === "button" && opts.name ? "approvalButton" : "role", { name: typeof opts.name === "string" ? opts.name : undefined }),
    keyboard: {
      press: async (key) => {
        state.keys.push(key);
        if (key === "Escape") state.cardVisible = false;
      },
    },
    evaluate: async () => null,
  };
  // 「审批卡」这个定位器是 getByRole("dialog").filter({ has: page.getByRole("button", { name: 正则 }) })，
  // 之后卡内的钮是 dlg.getByRole("button", { name: 文案, exact: true })——把这一支单独标出来
  const dialogs = locator("approvalDialogs");
  dialogs.getByRole = (role, opts = {}) => locator(role === "button" && typeof opts.name === "string" ? "approvalButton" : "approvalButtons", { name: typeof opts.name === "string" ? opts.name : undefined });
  dialogs.filter = () => dialogs;
  dialogs.first = () => dialogs;
  dialogs.locator = (sel) => locator(`approvalDialogs:${sel}`);
  const plainGetByRole = page.getByRole;
  page.getByRole = (role, opts) => (role === "dialog" ? dialogs : plainGetByRole(role, opts));
  const context = { pages: () => [page], newCDPSession: async () => ({ send: async () => ({ data: "" }), detach: async () => {} }) };
  const browser = { contexts: () => [context], close: async () => {} };
  return { state, page, browser };
}

const CARD = {
  payload: { tool: "bash", summary: "echo E2E-APPROVAL-SELFTEST-123456", mode: "full-approve", origin: "jishu-tool-approval" },
  buttons: ["拒绝", "仅本次允许"],
};
let current = null;
chromium.connectOverCDP = async () => current.browser;

const { open } = await import("./lib-pw.mjs");
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, message: String(e?.message || e) }));

// T1 调试口上不是 jishu-hub → 拒绝附着
current = makeFake({ url: "https://example.com/" });
{
  const r = await settle(open({ log: () => {} }));
  check("T1 页面地址不是 jishu-hub → 拒绝附着", !r.ok && /拒绝附着/.test(r.message) && /example\.com/.test(r.message), brief(r));
}
// T2 是 jishu-hub（生产地址）→ 附着成功
current = makeFake({ url: "http://tauri.localhost/" });
let app;
{
  const r = await settle(open({ log: () => {} }));
  check("T2 页面地址是 tauri.localhost → 附着成功", r.ok);
  app = r.v;
  const dev = makeFake({ url: "http://localhost:1420/" });
  current = dev;
  const r2 = await settle(open({ log: () => {} }));
  check("T2b 页面地址是开发地址 → 附着成功", r2.ok);
}
// T3 默认值：没有审批卡，回合已结束 → 正常返回
current = makeFake({ url: "http://tauri.localhost/" });
app = (await settle(open({ log: () => {} }))).v;
{
  const r = await settle(app.waitTurn({ budgetMs: 3000, settleMs: 300 }));
  check("T3 默认 approvals：没有卡 → done，setting=false，button=null", r.ok && r.v.done === true && r.v.approvals.setting === false && r.v.approvals.button === null && r.v.approvals.clicked === 0);
}
// T4 默认值：出现审批卡 → 按 Esc 拒绝，回合结束后抛错
current = makeFake({ url: "http://tauri.localhost/", card: CARD });
app = (await settle(open({ log: () => {} }))).v;
{
  const before = app.approvalLog.length;
  const r = await settle(app.waitTurn({ budgetMs: 4000, settleMs: 300 }));
  const log = app.approvalLog.slice(before);
  check(
    "T4 默认 approvals：有卡 → 按 Esc 拒绝并抛错，报错带卡上的命令",
    !r.ok && /出现了 1 张审批卡/.test(r.message) && /按 Esc 拒绝/.test(r.message) && r.message.includes("E2E-APPROVAL-SELFTEST-123456"),
    brief(r),
  );
  check("T4b 审批日志记下这一下（Esc，by=waitTurn）", log.length === 1 && /Esc/.test(log[0].button) && log[0].by === "waitTurn" && log[0].settled === true);
}
// T5 "allow"：点「仅本次允许」，返回点了几次、哪个钮
current = makeFake({ url: "http://tauri.localhost/", card: CARD });
app = (await settle(open({ log: () => {} }))).v;
{
  const r = await settle(app.waitTurn({ budgetMs: 4000, settleMs: 300, approvals: "allow" }));
  const a = r.ok ? r.v.approvals : {};
  check(
    'T5 approvals="allow" → 点「仅本次允许」一次，返回 button / items',
    r.ok && a.clicked === 1 && a.button === "仅本次允许" && a.items.length === 1 && a.items[0].button === "仅本次允许" && a.items[0].tool === "bash" && a.items[0].inScope === true && !current.state.keys.includes("Escape"),
  );
}
// T6 "allow" + 放行范围：范围外的卡点「拒绝」
current = makeFake({ url: "http://tauri.localhost/", card: CARD });
app = (await settle(open({ log: () => {} }))).v;
{
  const r = await settle(app.waitTurn({ budgetMs: 4000, settleMs: 300, approvals: "allow", approveOnly: (c) => (c.summary || "").includes("别的命令") }));
  check('T6 "allow" + approveOnly 不匹配 → 点「拒绝」，inScope=false，不抛错', r.ok && r.v.approvals.clicked === 1 && r.v.approvals.items[0].button === "拒绝" && r.v.approvals.items[0].inScope === false && !current.state.keys.includes("Escape"));
}
// T7 "deny"
current = makeFake({ url: "http://tauri.localhost/", card: CARD });
app = (await settle(open({ log: () => {} }))).v;
{
  const r = await settle(app.waitTurn({ budgetMs: 4000, settleMs: 300, approvals: "deny" }));
  check('T7 approvals="deny" → 点「拒绝」', r.ok && r.v.approvals.button === "拒绝" && r.v.approvals.clicked === 1 && !current.state.keys.includes("Escape"));
}
// T8 「始终允许」不点
{
  const r = await settle(app.clickApproval("always"));
  check("T8 clickApproval(\"always\") → 抛错", !r.ok && /始终允许/.test(r.message), brief(r));
}
// T9 旧版的 true 不再被接受
{
  const r = await settle(app.waitTurn({ budgetMs: 1000, settleMs: 100, approvals: true }));
  check("T9 approvals=true（旧的自动放行）→ 直接抛错", !r.ok && /只能是 false/.test(r.message), brief(r));
  const r2 = await settle(app.waitIdle(100, 1000, { approvals: true }));
  check("T9b waitIdle 同样", !r2.ok && /只能是 false/.test(r2.message));
}
// T10 waitIdle 默认值遇到卡
current = makeFake({ url: "http://tauri.localhost/", card: CARD });
app = (await settle(open({ log: () => {} }))).v;
{
  const r = await settle(app.waitIdle(200, 3000));
  check("T10 waitIdle 默认值：有卡 → 按 Esc 拒绝并抛错", !r.ok && /等空闲期间出现了 1 张审批卡/.test(r.message), brief(r));
}
// T11 用例租约：超时后轮询等待下一轮退出、后续驱动调用立即抛错
current = makeFake({ url: "http://tauri.localhost/", streaming: true });
app = (await settle(open({ log: () => {} }))).v;
{
  const lease = app.forCase();
  const t0 = Date.now();
  const waiting = settle(lease.app.waitTurn({ budgetMs: 20000, settleMs: 100 }));
  setTimeout(() => lease.expire(), 300);
  const r = await waiting;
  const ms = Date.now() - t0;
  check("T11 租约 expire 后：正在进行的 waitTurn 在下一轮退出（用例已超时，等待终止）", !r.ok && /用例已超时，等待终止/.test(r.message) && ms < 4000, `${ms}ms`);
  // 租约过期后驱动方法是**同步**抛错（不是返回被拒绝的 Promise）——在 async 函数里一样会变成 rejection
  const attempt = (fn) => {
    try {
      return settle(Promise.resolve().then(fn));
    } catch (e) {
      return Promise.resolve({ ok: false, message: String(e?.message || e) });
    }
  };
  const after = await attempt(() => lease.app.sleep(1));
  check("T11b 租约 expire 后：再调任何驱动方法立即抛错", !after.ok && /用例已超时，后续操作不再执行/.test(after.message) && lease.alive() === false);
  const again = await attempt(() => lease.app.waitTurn({ budgetMs: 1000, settleMs: 100 }));
  check("T11c 新的等待也立即抛错", !again.ok && /后续操作不再执行/.test(again.message));
  const fresh = app.forCase();
  const ok = await settle(fresh.app.waitIdle(100, 2000));
  check("T11d 新用例拿到的是新租约，照常可用", ok.ok && ok.v.idle === false); // 回合一直在跑（streaming=true）→ 等满时限返回 idle:false，不抛「超时」
}
// T12 清残留弹层遇到审批卡：按 Esc 拒绝并记日志、返回的文本以 [审批卡] 开头
current = makeFake({ url: "http://tauri.localhost/", card: CARD });
app = (await settle(open({ log: () => {} }))).v;
{
  // cancelResidualDialog 在卡收起后会去 getByRole("dialog").first().isVisible()——假页面里卡收起后为 false
  const before = app.approvalLog.length;
  const text = await app.cancelResidualDialog();
  const log = app.approvalLog.slice(before);
  check("T12 cancelResidualDialog 遇到审批卡 → Esc 拒绝、记日志、返回 [审批卡] 开头", /^\[审批卡\]/.test(String(text)) && log.length === 1 && log[0].by === "cancelResidualDialog", String(text).slice(0, 60));
}
// T13 用例视图里的 waitGraphRun 只传运行号：「用例是否还活着」要放进第三个参数，不能挤掉超时时长
//（修前被追加成第二个参数 → 截止时刻 NaN → 一轮不跑就返回空表，用例以为节点都跑完了——TS-4 首跑实跑踩到）
{
  const runs = { list: [{ node_id: "n1", status: "running", node_run_id: "nr1", attempt_count: 0 }] };
  const fake = makeFake({ url: "http://tauri.localhost/" });
  const baseEvaluate = fake.page.evaluate;
  fake.page.evaluate = async (fn, a) => {
    const cmd = Array.isArray(a) ? a[0] : null;
    if (cmd === "orchestrator_get_node_runs") return runs.list;
    if (cmd === "orchestrator_get_attempt") return { session_id: "s-node" };
    return baseEvaluate(fn, a);
  };
  current = fake;
  app = (await settle(open({ log: () => {} }))).v;
  const lease = app.forCase();
  const t0 = Date.now();
  const waiting = settle(lease.app.waitGraphRun("run-1"));
  // 节点 200 毫秒后跑完；waitGraphRun 每 2 秒看一次——要等到第二轮才返回
  setTimeout(() => {
    runs.list = [{ node_id: "n1", status: "succeeded", node_run_id: "nr1", attempt_count: 1 }];
  }, 200);
  const r = await waiting;
  const ms = Date.now() - t0;
  check(
    "T13 用例视图里 waitGraphRun(运行号)：等到节点都跑完才返回，带子会话号",
    r.ok && Array.isArray(r.v) && r.v.length === 1 && r.v[0].status === "succeeded" && r.v[0].sessionId === "s-node" && ms >= 1900,
    r.ok ? `${ms}ms ${JSON.stringify(r.v)}` : brief(r),
  );
  // 等待期间用例超时：下一轮循环里终止
  runs.list = [{ node_id: "n1", status: "running", node_run_id: "nr1", attempt_count: 0 }];
  const lease2 = app.forCase();
  const t1 = Date.now();
  const waiting2 = settle(lease2.app.waitGraphRun("run-1"));
  setTimeout(() => lease2.expire(), 300);
  const r2 = await waiting2;
  const ms2 = Date.now() - t1;
  check("T13b waitGraphRun 等待期间用例超时 → 下一轮循环里终止", !r2.ok && /用例已超时，等待终止/.test(r2.message) && ms2 < 4500, `${ms2}ms ${brief(r2)}`);
  const plain = await settle(app.waitGraphRun("run-1", 100)); // 不经用例视图、不传超时：10 毫秒后按当时的状态返回
  check("T13c 超时时长照常生效（100 毫秒后按当时的状态返回）", plain.ok && plain.v.length === 1 && plain.v[0].status === "running" && plain.v[0].sessionId === null, JSON.stringify(plain.v));
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n== lib-pw 离线自测：${results.length - failed} 过 · ${failed} 败`);
process.exit(failed ? 1 : 0);
