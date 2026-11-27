#!/usr/bin/env node
/**
 * lib-pw.mjs —— Playwright over CDP 驱动库（v0.9.8 需求20）
 *
 * 附着运行中的 jishu-hub（Windows/WebView2）并驱动界面：
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"` 启动应用后，
 * `chromium.connectOverCDP` 附着既有实例（只连接，不启动、不下载浏览器）。
 * 启动应用用同目录 start.mjs；跑用例用同目录 run.mjs（积木在 blocks/）。
 *
 * 驱动层内建的四件事（取代 raw CDP + 合成事件的「防呆」自律）：
 * 1. 可信事件——点击/输入走 CDP Input 域，页面收到 isTrusted:true 的完整序列
 *   （pointerdown→mousedown→pointerup→mouseup→click）；
 * 2. 命中测试——点击前自动等待目标 可见/稳定/启用 且命中点无遮挡，不满足抛错；
 * 3. strict mode——定位器多命中直接报错，不猜第一个；
 * 4. 自动重试断言——`expect(locator).toBeVisible()` 等 web-first 断言。
 *
 * 界面定位按中文界面编写（按钮 title / 文案）；run.mjs 启动时校验界面语言。
 *
 * 等回合时不替用户表态（v0.9.8 评审修复轮 R2 / 用户裁决 9）：waitTurn / waitIdle 的 approvals
 * 默认关闭——回合里出现审批卡，按 Esc（= 拒绝，与清残留弹层同向）并让用例失败、写明是哪一张；
 * 要放行或拒绝必须显式传 "allow" / "deny"，返回值里报告点了几次、点的哪个钮。
 * 审批的「同意」「不同意」各有一条自动化用例（blocks/approval.mjs）。
 *
 * 最小用法：
 *   import { open, expect } from "./lib-pw.mjs";
 *   const app = await open();
 *   await app.ensureWorkspace();
 *   await app.click("新对话");
 *   await expect(app.composer()).toBeVisible();
 *   await app.shot("D:/.../screenshots/1.png");
 *   await app.close();      // 只断开连接，不关应用
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { chromium } from "playwright";
import { expect } from "playwright/test";

export { expect };

/** CDP 端点（可用环境变量 JISHU_CDP_URL 覆盖，如多实例换端口）。 */
export const CDP_ENDPOINT = process.env.JISHU_CDP_URL || "http://127.0.0.1:9222";

/**
 * jishu-hub 页面的地址：生产包是 http://tauri.localhost/，开发模式是 http://localhost:1420/
 *（Tauri 的网页在 Windows 上的协议就是 tauri.localhost——别的程序开着同一个调试口时不是这个地址）。
 * 附着前先按它挑页面；一个都对不上就不附着（评审修复轮 R2：只看调试口通不通，会附着到别的程序上）。
 */
export function isJishuPageUrl(url) {
  return /^https?:\/\/(tauri\.localhost|localhost:\d+|127\.0\.0\.1:\d+)\/?/.test(String(url || ""));
}

/** 截图纪律视口（需求14 D14-1：生产包、1440×900）。传 null 沿用窗口原生尺寸。 */
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// PowerShell 调用（-EncodedCommand 传 UTF-16LE，免中文路径/文本经命令行转码损坏；
// 输出统一 UTF-8）。仅用于系统剪贴板、进程查询这类浏览器外的 OS 能力（Windows）。
export function runPowerShell(command) {
  const encoded = Buffer.from("[Console]::OutputEncoding=[Text.Encoding]::UTF8; " + command, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) =>
        err ? reject(new Error(String(stderr || stdout || err.message).trim().slice(0, 300))) : resolve(String(stdout || "").trim()),
    );
  });
}

/**
 * 会话落盘真值：读 pi 会话 JSONL 里按序的用户消息与助手文本（剥掉 hub 注入块）。
 * 「消息是否真的发出 / 按什么顺序发出 / 助手是否回话」以它为准——界面计数会被侧栏、
 * 折叠组、流式气泡污染。shortId = 会话头短 id（相近时间创建的会话间会重复，故只取
 * sinceMs 之后修改的最新匹配文件——传脚本/用例启动时刻）。
 * 会话文件根目录默认 `~/.jishu-agent/agent/sessions`，可用环境变量
 * JISHU_AGENT_SESSIONS_DIR 覆盖（非默认安装位置时）。
 *
 * 返回的口径：
 * - users / assistants / rawUsers / sequence：原有四个一个字不变（存量用例靠它们判事）；
 * - timeline：比 sequence 更全的落盘顺序——除用户 / 助手文字外，还记工具结果
 *   （`{ role: "toolResult", text: "工具名: 结果" }`）与压缩边界（引擎写的 compaction 条目，
 *   `{ role: "compaction" }`）。判断「工具结果在回复之前」「压缩排在谁后面」用它；
 * - assistantFull / assistantEnds / assistantLengths / assistantAt：与 assistants 一一对应——每段助手
 *   文字的全文（最多 4000 字）、末尾 60 字、全长、它在 timeline 里的行号；
 * - tools：工具执行结果 `[{ name, isError, text }]`（工具真的执行了没有，以它为准）；
 * - found：needles 里每个词在用户 / 助手 / 工具结果里出现没有（整段文字里找，不受截断影响）。
 */
export function readSessionUsers(shortId, sinceMs = 0, needles = []) {
  const root = process.env.JISHU_AGENT_SESSIONS_DIR || path.join(os.homedir(), ".jishu-agent", "agent", "sessions");
  if (!shortId || !fs.existsSync(root)) return null;
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.includes(`_${shortId}`) && e.name.endsWith(".jsonl") && fs.statSync(p).mtimeMs >= sinceMs) hits.push(p);
    }
  })(root);
  if (!hits.length) return null;
  hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const clean = (t) => t.split("<JISHU")[0].split("<!--JISHU")[0].trim();
  const users = [];
  const assistants = [];
  // v0.9.8 评审修复轮：以下两项不剥离注入块 / 不丢空消息——验证「注入了什么」
  //（工具说明块是否带上）与「谁在谁之后」（重发的消息后面有没有回复）时用。
  const rawUsers = [];
  const sequence = [];
  // v0.9.8 评审修复轮 R2：更全的落盘顺序、工具结果、每段助手文字的全文 / 末尾 / 全长、按词查找（见函数注释）
  const timeline = [];
  const tools = [];
  const assistantFull = [];
  const assistantAt = [];
  const assistantEnds = [];
  const assistantLengths = [];
  const found = Object.fromEntries(needles.map((n) => [n, { user: false, assistant: false, tool: false, toolError: false }]));
  for (const line of fs.readFileSync(hits[0], "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    // 压缩边界：引擎把摘要写成一条 type=compaction 的条目，按落盘顺序记一行
    if (o.type === "compaction") {
      timeline.push({ role: "compaction", text: "(压缩边界)" });
      continue;
    }
    const m = o.message || {};
    // 工具执行结果（role=toolResult）：被拒绝 / 被拦截的调用也在这里，isError 为真、文本是拒绝原因
    if (m.role === "toolResult") {
      const tc = m.content;
      const toolText = typeof tc === "string" ? tc : (tc || []).map((b) => (b && b.type === "text" ? b.text || "" : "")).join("\n");
      const entry = { name: m.toolName ?? null, isError: Boolean(m.isError), text: clean(toolText).replace(/\n+/g, " ").slice(0, 160) };
      tools.push(entry);
      timeline.push({ role: "toolResult", text: `${entry.name ?? "?"}: ${entry.text.slice(0, 40)}` });
      for (const n of needles) {
        if (!toolText.includes(n)) continue;
        found[n].tool = true;
        if (m.isError) found[n].toolError = true;
      }
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    const c = m.content;
    const texts = typeof c === "string" ? [c] : (c || []).filter((b) => b && b.type === "text").map((b) => b.text || "");
    const raw = texts.join("\n");
    if (m.role === "user") rawUsers.push(raw);
    const rowText = clean(raw).replace(/\n+/g, " ").slice(0, 40);
    sequence.push({ role: m.role, text: rowText });
    const rowIndex = timeline.length;
    timeline.push({ role: m.role, text: rowText });
    for (let t of texts) {
      const full = clean(t).replace(/\n+/g, " ");
      if (!full) continue;
      if (m.role === "user") {
        users.push(full);
        for (const n of needles) if (full.includes(n)) found[n].user = true;
      } else {
        assistants.push(full.slice(0, 120));
        assistantFull.push(full.slice(0, 4000));
        assistantEnds.push(full.slice(-60));
        assistantLengths.push(full.length);
        assistantAt.push(rowIndex);
        for (const n of needles) if (full.includes(n)) found[n].assistant = true;
      }
    }
  }
  return { file: path.basename(hits[0]), users, assistants, rawUsers, sequence, timeline, tools, assistantFull, assistantAt, assistantEnds, assistantLengths, found };
}

/** 步骤记录器：结论同时进 console 与结果文件（后台运行时 stdout 缓冲会产出空日志假象）。 */
export function recorder(file) {
  const rec = { steps: [], issues: [] };
  return {
    rec,
    mark(k, v) {
      rec.steps.push({ k, v });
      console.log(k, "=", JSON.stringify(v ?? null).slice(0, 400));
    },
    issue(v) {
      rec.issues.push(v);
      console.log("ISSUE:", JSON.stringify(v).slice(0, 400));
    },
    flush(extra = {}) {
      Object.assign(rec, extra);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    },
  };
}

/**
 * 用例执行壳：单条失败不中断整轮，结果/耗时/错误进 recorder。
 *   const { rec, mark, flush } = recorder(file);
 *   const run = harness({ rec, mark });
 *   await run("D1", "附着与页面发现", async () => { …; return { 事实 }; });
 */
export function harness({ rec, mark }) {
  return async function runCase(id, name, fn) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      const row = { id, name, ok: true, ms: Date.now() - t0, detail };
      rec.cases = rec.cases || [];
      rec.cases.push(row);
      mark(`${id} ${name}`, { ok: true, ms: row.ms, ...detail });
      return row;
    } catch (e) {
      const row = { id, name, ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 600) };
      rec.cases = rec.cases || [];
      rec.cases.push(row);
      mark(`${id} ${name}`, { ok: false, ms: row.ms, error: row.error.slice(0, 400) });
      return row;
    }
  };
}

/**
 * 附着运行中的应用并返回驱动对象。
 *
 * @param {{ log?: Function, viewport?: {width:number,height:number}|null, actionTimeout?: number }} opts
 *   - viewport：截图/布局视口仿真；null = 不仿真（不动既有仿真）。
 *   - actionTimeout：定位器动作默认超时（ms）。
 */
export async function open({ log = console.log, viewport = DEFAULT_VIEWPORT, actionTimeout = 10000 } = {}) {
  const t0 = Date.now();
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close();
    throw new Error(`无 browser context——应用是否带 --remote-debugging-port 启动？(${CDP_ENDPOINT})`);
  }
  // 页面发现：Tauri 单窗口；只认 jishu-hub 的页面地址（生产 tauri.localhost、开发 localhost:端口）。
  // 评审修复轮 R2：调试口上可能是别的程序（同一个端口被 Chrome / Edge / 别的 Tauri 应用占着）——
  // 一个都对不上就断开、不附着，别把点击打到别人的页面上。
  let page = null;
  const deadline = Date.now() + 10000;
  const seen = new Set();
  while (!(page = context.pages().find((p) => isJishuPageUrl(p.url())))) {
    for (const p of context.pages()) if (!p.url().startsWith("devtools")) seen.add(p.url().slice(0, 80));
    if (Date.now() > deadline) {
      await browser.close();
      throw new Error(
        seen.size
          ? `调试口 ${CDP_ENDPOINT} 上不是 jishu-hub——拒绝附着（调试口上的页面：${[...seen].join(" | ")}）。换个端口：start.mjs --port <端口>，并让运行器用同一个端口（环境变量 JISHU_CDP_URL）`
          : `10s 内未发现 page target（${CDP_ENDPOINT}/json/list）`,
      );
    }
    await sleep(200);
  }
  page.setDefaultTimeout(actionTimeout);

  // 错误捕获：Playwright 事件订阅挂在 Page 对象上，同一目标跨 reload 存活。
  // ⚠ 本应用 main.tsx 的 window.onerror 会把整个界面替换成「Frontend Error」页——
  //   脚本不要故意制造未捕获异常（验证捕获链用 console.error）；误入错误页用 page.reload() 恢复。
  const errors = [];
  page.on("pageerror", (e) => errors.push("EXC:" + String(e?.message || e).slice(0, 300)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("ERR:" + m.text().slice(0, 300));
  });

  // 视口仿真与截图走同一 CDP 会话：Playwright 自带 page.screenshot 在系统缩放屏
  //（如 150%）出物理像素（1440×900 → 2160×1350），与既有截图纪律不一致——
  // 截图固定用 Page.captureScreenshot 原始抓取。
  const cdp = viewport ? await context.newCDPSession(page) : null;
  const setViewport = async (v) => {
    if (!cdp) return;
    if (v) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: false });
    } else {
      await cdp.send("Emulation.clearDeviceMetricsOverride");
    }
  };
  await setViewport(viewport);

  const ev = async (expression) => {
    try {
      return await page.evaluate(expression);
    } catch (e) {
      return "EVAL_EXC:" + String(e?.message || e).slice(0, 300);
    }
  };
  // 旧骨架同形：返回值经 JSON 往返（页面表达式返回字符串时尝试解析）。
  const evj = async (expression) => {
    const v = await ev(expression);
    if (typeof v === "string" && v.startsWith("EVAL_EXC:")) {
      log("evj exc:", v.slice(0, 200));
      return null;
    }
    if (typeof v !== "string") return v ?? null;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  /** Tauri 命令直调（跨端契约锚定）——后端报错时 reject（区别于 ev 的字符串透出）。 */
  const invoke = (cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

  const bodyText = () => page.evaluate(() => document.body.textContent || "");
  /** 页面文本签名等待（textContent 口径——不被 line-clamp 截断）；超时返回 false。 */
  const waitFor = (sig, timeoutMs = 15000, polling = 400) =>
    page
      .waitForFunction((s) => (document.body.textContent || "").includes(s), sig, { timeout: timeoutMs, polling })
      .then(() => true, () => false);
  const gone = (sig, timeoutMs = 15000, polling = 400) =>
    page
      .waitForFunction((s) => !(document.body.textContent || "").includes(s), sig, { timeout: timeoutMs, polling })
      .then(() => true, () => false);
  /** 界面是否中文（定位器按中文界面编写）。用标题栏的「管理」「外观」判断——工作区与管理页都有。 */
  const isChineseUI = async () => {
    const head = (await bodyText()).slice(0, 300);
    return head.includes("管理") && head.includes("外观");
  };

  /** 导航后语义落点校验（防「点对元素但进错页面」——actionability 管不到这层）。 */
  const assertLanding = async (sigs, timeoutMs = 8000) => {
    const need = [].concat(sigs);
    try {
      await page.waitForFunction(
        (list) => {
          const t = (document.body.textContent || "").slice(0, 4000);
          return list.every((x) => t.includes(x));
        },
        need,
        { timeout: timeoutMs, polling: 300 },
      );
      return { ok: true, missing: [] };
    } catch {
      const t = (await bodyText()).slice(0, 4000);
      return { ok: false, missing: need.filter((x) => !t.includes(x)) };
    }
  };
  /** 点击 + 落点校验：落点特征未出现直接抛错（导航类点击一律走这里）。 */
  const navClick = async (locator, { sig, sigs, timeout = 8000 } = {}) => {
    await locator.click();
    const need = sig ? [sig] : [].concat(sigs || []);
    if (need.length) {
      const r = await assertLanding(need, timeout);
      if (!r.ok) throw new Error(`落点校验失败，缺少特征: ${r.missing.join(" | ")}`);
    }
    return true;
  };

  /** 语义点击：role + 精确可访问名（strict——多命中报错不猜）。scope 传 Locator 收窄。 */
  const click = (name, { role = "button", exact = true, scope, timeout } = {}) =>
    (scope || page).getByRole(role, { name, exact }).click({ timeout });
  /** 文本点击（非 button 语义的可点元素，如固定项目标签 div）。 */
  const clickText = (text, { exact = true, scope, timeout } = {}) =>
    (scope || page).getByText(text, { exact }).click({ timeout });
  /** 图标按钮按 title 点击（button[title="…"] 精确）。 */
  const clickTitle = (title, { scope, timeout } = {}) =>
    (scope || page).locator(`button[title=${JSON.stringify(title)}]`).click({ timeout });

  // ── 侧栏与导航 ──
  const sidebar = () => page.locator(".chat-sidebar");
  /** 侧栏顶部显示的项目名（切项目标签后的落点锚；含同排按钮文字）。 */
  const sidebarProjectName = () => sidebar().evaluate((sb) => (sb.firstElementChild?.textContent || "").trim().slice(0, 40));
  /** 标题栏「当前项目」标签显示名（未停在项目工作区时为空串）。 */
  const currentProjectName = () =>
    page.evaluate(() => {
      const tab = [...document.querySelectorAll("div[title]")].find((d) => d.classList.contains("border-b-0"));
      return (tab?.querySelector("span.truncate")?.textContent || "").trim();
    });
  /** 已固定（可拖拽）的项目标签显示名。 */
  const pinnedProjectLabels = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("div[draggable][title]")]
        .map((d) => (d.querySelector("span.truncate")?.textContent || "").trim())
        .filter(Boolean),
    );
  /** 侧栏前 limit 个会话行的标题（行内第一个有文字的叶子元素——标题排在相对时间之前）。 */
  const listSessionTitles = (limit = 10) =>
    page.evaluate((n) => {
      const titleOf = (row) =>
        ([...row.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.textContent || "").trim())?.textContent || "").trim();
      return [...document.querySelectorAll(".chat-sidebar button.flex-col.items-start")].slice(0, n).map(titleOf);
    }, limit);
  /** 会话头（标题 + 短 id）——落点校验锚；未停在会话页返回 null。 */
  const sessionHeader = () =>
    page.evaluate(() => {
      const idEl = [...document.querySelectorAll("span.font-mono")].find((e) => {
        const r = e.getBoundingClientRect();
        return r.top >= 0 && r.top < 90 && r.left > 230 && /^[0-9a-f]{8}$/.test((e.textContent || "").trim());
      });
      if (!idEl) return null;
      return { id: (idEl.textContent || "").trim(), title: (idEl.previousElementSibling?.textContent || "").trim() };
    });
  // 会话头短 id 元素原文（新会话解析前显示 pending-；需求21 用例据此记录暂存发生的时刻）
  const headerIdText = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll("span.font-mono")].find((e) => {
        const r = e.getBoundingClientRect();
        return r.top >= 0 && r.top < 90 && r.left > 230;
      });
      return el ? (el.textContent || "").trim() : "";
    });
  /**
   * 等新会话的真实 id 解析完成（会话头不再是 pending-）。
   * 解析完成前暂存的消息会随 id 解析搬到真实键（v0.9.8 需求21 修复；修前会丢失，
   * 见 docs/v0.9.8/测试/issues/04）。
   */
  const waitSessionResolved = async (timeoutMs = 15000, alive = null) => {
    const deadline = Date.now() + timeoutMs;
    let id = "";
    while (Date.now() < deadline) {
      if (alive && !alive()) throw new Error("用例已超时，等待终止");
      id = await headerIdText();
      if (id && !/^pending/.test(id)) return id;
      await sleep(150);
    }
    throw new Error(`会话 id 在 ${timeoutMs}ms 内未解析（会话头仍是「${id}」）`);
  };
  const rowTitle = (row) =>
    row.evaluate(
      (el) => ([...el.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.textContent || "").trim())?.textContent || "").trim(),
    );
  /**
   * 打开侧栏会话并校验落点。会话行的可访问名 = `标题 相对时间`：
   * - title：精确标题（strict——多个同名行报错）；
   * - keyword：关键词匹配，候选中取文本最短的一条（会话标题会被自动改写——禁全等猜测）。
   * 落点：会话头标题必须等于所点行标题，否则抛错
   *（「点成功但停在旧会话」的假发现——A7 R2 G3g——在此杜绝）。
   */
  const openSession = async ({ title, keyword, timeout = 8000 } = {}) => {
    const key = title ?? keyword;
    if (!key) throw new Error("openSession 需要 title 或 keyword");
    const rows = sidebar().getByRole("button", {
      name: title ? new RegExp("^" + escapeRegExp(title) + "\\s") : new RegExp(escapeRegExp(keyword)),
    });
    const n = await rows.count();
    if (!n) throw new Error(`侧栏未找到会话「${key}」`);
    if (title && n > 1) throw new Error(`侧栏有 ${n} 个以「${title}」开头的会话行——请用更精确的标题`);
    let idx = 0;
    if (!title) {
      const names = (await rows.allTextContents()).map((s) => s.trim());
      idx = names.reduce((best, s, i) => (s.length < names[best].length ? i : best), 0);
    }
    const row = rows.nth(idx);
    const expected = await rowTitle(row);
    await row.click();
    const deadline = Date.now() + timeout;
    let head = null;
    while (Date.now() < deadline) {
      head = await sessionHeader();
      if (head && head.title === expected) return head;
      await sleep(200);
    }
    throw new Error(`落点校验失败：点了「${expected}」，会话头却是「${head ? head.title : "(无会话头)"}」`);
  };
  /**
   * 切固定项目标签（div[draggable]，非 button 语义）并校验落点：侧栏顶部项目名
   * 必须变化（expectName 给定时还须命中该正则）。返回 { before, after }。
   */
  const switchProject = async (name, { expectName, timeout = 8000 } = {}) => {
    const before = await sidebarProjectName();
    // 标签文字全等匹配（防「test」误中「test2」）
    const tab = page.locator("div[draggable][title]").filter({
      has: page.locator("span.truncate", { hasText: new RegExp("^" + escapeRegExp(name) + "$") }),
    });
    await tab.click();
    const re = expectName ? new RegExp(expectName) : null;
    const deadline = Date.now() + timeout;
    let after = before;
    while (Date.now() < deadline) {
      after = await sidebarProjectName();
      if (re ? re.test(after) : after !== before) return { before, after };
      await sleep(200);
    }
    throw new Error(`落点校验失败：点了项目标签「${name}」，侧栏项目名仍是「${after}」`);
  };
  /** 工作区是否可见输入框。 */
  const onWorkspace = () => composer().isVisible().catch(() => false);
  const backToWorkspace = async () => {
    if (await onWorkspace()) return;
    await click("返回工作区");
    await expect(composer()).toBeVisible();
  };
  /**
   * 残留弹层清理：屏幕上有弹层且有「取消」钮就取消（上次脚本中断常把「能力重叠」
   * 确认卡留在屏幕上——模态开着时背景元素对角色定位不可见，后续导航全部落空）。
   * 冲突卡一律取消：自动化不触发「停用并安装」（会停用用户已装的内置扩展）。
   * 审批卡（没有取消钮）按 Esc——等于拒绝，与 waitTurn 的默认同向；记进审批日志
   *（app.approvalLog），返回的文本以「[审批卡]」开头，运行器据此在报告里单列。
   * 返回被关闭的弹层文本，无弹层返回 null。
   */
  const cancelResidualDialog = async () => {
    let lastText = null;
    // 弹层可能叠着（上一用例中途失败常留一个）：逐个关，最多 3 层
    for (let layer = 0; layer < 3; layer++) {
      const card = await approvalCard();
      if (card) {
        const item = await rejectApprovalByEscape("cancelResidualDialog", "用例之间清残留弹层");
        lastText = `[审批卡] ${item.button}｜工具 ${card.tool ?? "?"}｜${(card.summary || "").slice(0, 80)}`;
        if (!item.settled) break; // 关不掉就停手，交给用例自己报错
        continue;
      }
      const dlg = page.getByRole("dialog").first();
      if (!(await dlg.isVisible().catch(() => false))) break;
      const text = (await dlg.textContent()).replace(/\s+/g, " ").slice(0, 160);
      const cancel = dlg.getByRole("button", { name: /^取消/ });
      // 没有取消钮的弹层（套装详情等）点关闭钮——模态开着时背景按钮点不到，后续用例会全部落空
      const close = dlg.getByRole("button", { name: /^(Close|关闭)$/ });
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
      else if (await close.first().isVisible().catch(() => false)) await close.first().click();
      else {
        await page.keyboard.press("Escape").catch(() => {});
      }
      await expect(dlg).toBeHidden({ timeout: 5000 }).catch(() => {});
      lastText = text;
      if (await dlg.isVisible().catch(() => false)) break; // 关不掉就停手，交给用例自己报错
    }
    return lastText;
  };
  /**
   * 导航前置（每个用例开头必调）：清残留弹层 → 回到工作区 →（给了项目名且当前不符时）
   * 切到该项目并校验落点。缺这一步，用例会在用户正停留的项目/页面里操作。
   */
  const ensureWorkspace = async (project) => {
    await cancelResidualDialog();
    if (/Frontend Error/.test((await bodyText()).slice(0, 200))) {
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    // 等界面落定：输入框（工作区）或「返回工作区」（管理页）任一可见。刚 reload / 切页后输入框
    // 要几百毫秒才渲染——只看一眼就断定「不在工作区」会去等一个不存在的按钮。
    await expect(composer().or(page.getByRole("button", { name: "返回工作区", exact: true })).first()).toBeVisible({ timeout: 20000 });
    await backToWorkspace();
    if (project && project !== (await currentProjectName())) {
      if (project === (await sidebarProjectName()).slice(0, project.length)) return project;
      await switchProject(project, { expectName: project });
    }
    await expect(composer()).toBeVisible();
    return currentProjectName();
  };
  /** 新对话（断言输入框为空），返回会话头（发出首条消息前为 null）。
   * 新对话页会恢复上次没发出去的草稿（产品行为）——上一条用例中途失败时可能把半截
   * 输入留在这里。测试需要干净起点：有残留就清空并如实返回，不让它混进本用例的消息。
   */
  const newConversation = async () => {
    await click("新对话");
    await expect(composer()).toBeVisible();
    await clearComposerLeftover();
    await expect(composer()).toHaveValue("");
    return sessionHeader();
  };
  /** 清掉输入框里残留的半截输入（输入框可见且非空时）；返回被清掉的内容，没有返回 ""。 */
  const clearComposerLeftover = async () => {
    const box = composer();
    if (!(await box.isVisible().catch(() => false))) return "";
    const value = await box.inputValue().catch(() => "");
    if (!value) return "";
    await box.fill("").catch(() => {});
    return value;
  };
  /**
   * 关闭输入区弹层。+ 菜单 / 智能体菜单 / 权限菜单是自定义实现（无 Esc 处理），靠
   * 工具栏外的真实 mousedown 关闭——点侧栏搜索框这个惰性目标触发。
   */
  const dismiss = async () => {
    await page.keyboard.press("Escape").catch(() => {});
    const box = sidebar().locator("input").first();
    if (await box.isVisible().catch(() => false)) await box.click({ timeout: 2000 }).catch(() => {});
    return true;
  };
  /** + 菜单弹层范围（自定义弹层无 role：取同时含两组标签的最内层容器）——同名按钮收窄用。 */
  const plusMenu = () => page.locator("div").filter({ hasText: "输入素材" }).filter({ hasText: "能力挂载" }).last();
  /**
   * 智能体切换触发钮的 title（= 当前智能体显示名，随环境变化）：输入区工具栏里
   * 排在「切换」（页面切换菜单）之后的那个带 title 的按钮。找不到返回 ""。
   */
  const agentSwitchTitle = () =>
    page.evaluate(() => {
      const btns = [...document.querySelectorAll("button[title]")].filter((b) => b.getBoundingClientRect().height > 0);
      const i = btns.findIndex((b) => b.title === "切换");
      return i >= 0 && btns[i + 1] ? btns[i + 1].title : "";
    });
  /** 关闭装后引导卡（右下角 fixed 提示，会盖住输入区右下角）。 */
  const closeGuideCards = async () => {
    const cards = page.locator("[data-install-guide]");
    for (const card of await cards.all()) {
      await card.getByRole("button", { name: "关闭" }).click({ timeout: 1500 }).catch(() => {});
    }
    return true;
  };
  /**
   * 导航到插件市场指定页签（状态感知）：先清残留弹层；在工作区才点「管理」
   *（已在管理页则不再点——多余的一次切换会让后续落点校验落空）。
   */
  const openMarket = async (tab = "扩展生态") => {
    const cleared = await cancelResidualDialog();
    if (!(await page.getByRole("button", { name: "返回工作区", exact: true }).isVisible().catch(() => false))) {
      await backToWorkspace();
      await click("管理");
      await expect(page.getByRole("button", { name: "返回工作区", exact: true })).toBeVisible();
    }
    await navClick(page.getByRole("button", { name: "插件中心", exact: true }), { sig: "插件市场" });
    await navClick(page.getByRole("button", { name: "插件市场", exact: true }), { sig: tab });
    await click(tab);
    return { cleared };
  };

  // ── 任务会话行 ──
  /** 侧栏「任务会话」分组（分组头按钮的父容器）里的任务行。 */
  const taskRows = () =>
    sidebar().getByRole("button", { name: /任务会话/ }).locator("xpath=..").locator("button").filter({ hasNotText: "任务会话" });
  /** 当前项目的任务实例（按侧栏项目名对上项目路径；对不上时退到「最近项目」）。 */
  const taskRecords = async () => {
    const name = await currentProjectName();
    const projects = await invoke("scan_projects").catch(() => []);
    const hit = (projects || []).find((p) => p.name === name);
    const root = hit ? hit.path : await invoke("load_last_project").catch(() => null);
    if (!root) return [];
    const items = await invoke("task_launch_list_sessions", { projectRoot: root }).catch(() => []);
    return Array.isArray(items) ? items : [];
  };
  /**
   * 点任务行并校验落点：会话头的短号必须是这个任务的会话。
   *（短号只有 8 位，相近时间建的会话可能重复——需要更强的落点保证时再核对会话内容。）
   */
  const openTaskRow = async (row, task) => {
    await row.click();
    const deadline = Date.now() + 10000;
    let head = null;
    while (Date.now() < deadline) {
      head = await sessionHeader();
      if (head?.id && task.task_session_id?.startsWith(head.id)) return head;
      await sleep(200);
    }
    throw new Error(
      `点任务行后落点不对：会话头 ${head ? `${head.id}「${head.title}」` : "(没有会话头)"}，期望会话 ${(task.task_session_id || "(无)").slice(0, 8)}「${task.title}」`,
    );
  };
  /**
   * 会话行行首状态：streaming（蓝色呼吸，回合进行中）/ done（绿：有完成结果未读）/
   * failed（红：有失败结果未读）/ idle（空占位）。任务行与常规会话行同一种标记。
   */
  const rowState = async (row) => {
    if (await row.locator("span.rounded-full.animate-pulse").first().isVisible().catch(() => false)) return "streaming";
    if (!(await row.locator("span.rounded-full.bg-emerald-500, span.rounded-full.bg-red-500").first().isVisible().catch(() => false))) {
      return "idle";
    }
    return (await row.locator("span.rounded-full.bg-red-500").first().isVisible().catch(() => false)) ? "failed" : "done";
  };

  /** 等会话行进入给定状态之一；超时返回最后看到的状态。 */
  const waitRowState = async (row, wanted, timeout, alive = null) => {
    const deadline = Date.now() + timeout;
    let last = "idle";
    while (Date.now() < deadline) {
      if (alive && !alive()) throw new Error("用例已超时，等待终止");
      last = await rowState(row);
      if (wanted.includes(last)) return last;
      await sleep(700);
    }
    return last;
  };

  // ── 带任务图的任务（「节点会话」类用例自己造数，不靠模型规划）──
  /** 当前项目在项目列表里的记录（按侧栏项目名对上；对不上返回 null）。 */
  const projectInfo = async () => {
    const name = await currentProjectName();
    const projects = await invoke("scan_projects").catch(() => []);
    return (projects || []).find((p) => p.name === name) ?? null;
  };

  /**
   * 会话头上的 8 位短号对应的完整会话 id。相近时间建的会话短号会重复（只取第一个匹配）——
   * 调用方判断落到哪个会话要靠内容，不能只比短号。
   */
  const sessionFullId = async (shortId, encodedName) => {
    const sessions = await invoke("list_sessions", { agentId: "jishu-self", encodedName }).catch(() => []);
    return (sessions || []).find((s) => s.id.startsWith(shortId))?.id ?? null;
  };

  /**
   * 造一个任务——**全程真实用户操作**（2026-11-27 用户裁决：测试禁止直造数据，只能 GUI/CLI
   * 模拟真实用户；原先直调后端命令建图建任务挂主会话的做法已废止）：点「新任务」→ 输入目标
   * 并发送。任务实例由发送链路真实创建（发送时登记、会话解析后绑定），主会话就是这场对话本身。
   * goal 的提示词要写明「不要调用任何工具」——不让智能体动项目里的文件、不弹审批卡。
   * 返回 { task, mainShortId }（task 是任务列表里的那一条记录）。模型不可用时抛的错以
   * 「模型不可用」开头，调用方据此标跳过。
   * 任务留在项目里供后续用例复用（滚动/未读类用例优先用现成任务，不会重复造）。
   */
  const createTaskViaGui = async ({ goal }) => {
    await newConversation();
    await page.locator('button[title="新任务"]').first().click();
    const before = new Set((await taskRecords()).map((r) => r.task_id));
    await send(goal);
    const started = await awaitTurnStart(20000);
    if (!started) throw new Error("模型不可用：任务首条消息发出后 20 秒内回合未启动");
    const turn = await waitTurn({ budgetMs: 180000, settleMs: 3000 });
    await waitIdle(2000, 120000);
    if (!turn.done) throw new Error("任务的回合没有在时限内结束");
    // 任务会话没有常规会话头——认领靠差集：发送链路新建的那条任务
    const added = (await taskRecords()).filter((r) => !before.has(r.task_id) && r.task_session_id);
    if (!added.length) throw new Error("发送链路没有建出任务（任务列表没有新增带会话的行）——任务创建失败");
    const task = added[0];
    return { task, mainShortId: (task.task_session_id ?? "").slice(0, 8) };
  };

  /**
   * 等一次执行里所有节点都跑完。返回 [{ nodeId, status, sessionId, agentId }]；超时返回当时的状态。
   * sessionId 是这个节点那一轮执行产生的子会话。（只读观测，不是造数。）
   */
  const waitGraphRun = async (runId, timeout = 240000, alive = null) => {
    const done = new Set(["succeeded", "failed", "cancelled", "canceled", "skipped"]);
    const deadline = Date.now() + timeout;
    let runs = [];
    while (Date.now() < deadline) {
      if (alive && !alive()) throw new Error("用例已超时，等待终止");
      runs = await invoke("orchestrator_get_node_runs", { runId }).catch(() => []);
      if (Array.isArray(runs) && runs.length > 0 && runs.every((r) => done.has(String(r.status).toLowerCase()))) break;
      await sleep(2000);
    }
    const out = [];
    for (const r of Array.isArray(runs) ? runs : []) {
      const attemptCount = r.attempt_count ?? 0;
      // attempt 编号从 0 开始，最新一次 = attempt_count - 1
      const attempt =
        attemptCount > 0
          ? await invoke("orchestrator_get_attempt", { nodeRunId: r.node_run_id, attemptNumber: attemptCount - 1 }).catch(() => null)
          : null;
      out.push({ nodeId: r.node_id, status: r.status, sessionId: attempt?.session_id ?? null, agentId: attempt?.agent_assignment?.agent_id ?? null });
    }
    return out;
  };

  // ── 访问权限档位（输入区的「访问权限」菜单；审批类用例切档、还原，冒烟的 C4c 也用）──
  /**
   * 当前会话用的智能体 id——与前端 AgentContext 同一套规则：界面记忆里有、且在清单里就用它；
   * 否则默认内建引擎（jishu-self），清单里连它都没有才退到第一个已安装的 / 第一项。
   */
  const chatAgentId = async () =>
    page.evaluate(async () => {
      const list = (await window.__TAURI_INTERNALS__.invoke("agent_list_statuses").catch(() => [])) || [];
      const saved = localStorage.getItem("jishu-hub.chatAgentId");
      if (saved && list.some((a) => a.id === saved)) return saved;
      if (list.some((a) => a.id === "jishu-self")) return "jishu-self";
      return (list.find((a) => a.health?.installed) ?? list[0])?.id ?? null;
    });
  /**
   * 读回工具模式：{ agentId, provider, modes, mode, effective, toolApproval }。
   * - mode：Hub 存的原始值。从未设置过时后端返回 null，界面按「完全访问」显示（effective 就是界面上生效的那一档）；
   * - toolApproval：Pi 设置里的那一半（变更前审批 = ask_always、智能审批 = smart、其余 = off）。只把这一个字段带出页面——
   *   配置里可能有密钥，整份不读进测试进程；
   * - 智能体不是「Hub 工具模式」这一类（claude-code / codex 走自己的配置）：provider 如实返回，mode 为 undefined。
   */
  const readToolMode = async () => {
    const agentId = await chatAgentId();
    if (!agentId) return { agentId: null, provider: null, modes: [], mode: undefined, effective: undefined, toolApproval: null };
    return page.evaluate(async (id) => {
      const call = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
      const list = (await call("agent_list_statuses", {}).catch(() => [])) || [];
      const agent = list.find((x) => x.id === id) ?? null;
      const provider = agent?.permission_mode_provider ?? null;
      const modes = agent?.permission_modes ?? [];
      if (provider !== "hub_tool_mode") return { agentId: id, provider, modes, mode: undefined, effective: undefined, toolApproval: null };
      const config = await call("load_config", { agentId: id }).catch(() => null);
      const mode = (await call("get_agent_tool_mode", { agentId: id }).catch(() => null)) ?? null;
      return { agentId: id, provider, modes, mode, effective: mode ?? "full", toolApproval: config?.toolApproval ?? null };
    }, agentId);
  };
  /** 触发钮：可以切换时 title 是「访问权限」；当前智能体不支持切换时 title 是「当前智能体暂不支持切换」。 */
  const accessTrigger = () => page.locator('button[title="访问权限"]');
  /** 当前档位：{ switchable, label }——label 是触发钮上显示的文字（只读模式 / 完全访问 / 变更前审批 / 智能审批…）。 */
  const accessMode = async () => {
    const trigger = accessTrigger().first();
    if (!(await trigger.isVisible().catch(() => false))) {
      const unsupported = await page.locator('button[title="当前智能体暂不支持切换"]').first().isVisible().catch(() => false);
      return { switchable: false, label: unsupported ? "当前智能体暂不支持切换" : "", options: [] };
    }
    return { switchable: true, label: ((await trigger.textContent()) || "").trim(), options: [] };
  };
  /** 读权限菜单里的全部档位文字（要开一次菜单、读完关掉）。回合进行中触发钮是禁用的，此时返回空数组。 */
  const accessModeOptions = async () => {
    const trigger = accessTrigger().first();
    if (!(await trigger.isVisible().catch(() => false)) || (await trigger.isDisabled().catch(() => true))) return [];
    await dismiss();
    await trigger.click();
    // 菜单项是触发钮的兄弟节点，且自身没有 title；第一层 span 是档位文字（下一行是说明）
    const items = trigger.locator("xpath=..").locator("button:not([title])");
    await items.first().waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    const labels = [];
    for (const item of await items.all()) {
      const label = ((await item.locator("span").first().textContent().catch(() => "")) || "").trim();
      if (label) labels.push(label);
    }
    await dismiss();
    return labels;
  };
  /**
   * 切到指定档位（按菜单项的文字）：点触发钮 → 点菜单项 → 等触发钮文案变成它（后端保存完前端才重读）。
   * 已经在这一档就什么都不做。返回 { before, after, switched }。
   * 副作用（产品行为）：写 Hub 状态与 Pi 设置，并重启该智能体全部会话的引擎进程——调用方先确认没有回合在跑。
   */
  const setAccessMode = async (label) => {
    const trigger = accessTrigger().first();
    await expect(trigger).toBeEnabled({ timeout: 20000 });
    const before = ((await trigger.textContent()) || "").trim();
    if (before === label) return { before, after: before, switched: false };
    await dismiss();
    await trigger.click();
    // 菜单项与触发钮文字相同（当前档位就是这一档时）：排除触发钮内部再找
    const item = page.locator(`:text-is('${label}'):not([title='访问权限'] *)`);
    await expect(item).toBeVisible({ timeout: 5000 });
    await item.click();
    await expect(trigger).toHaveText(label, { timeout: 20000 });
    return { before, after: label, switched: true };
  };

  // ── 会话区 ──
  /** 当前可见的输入框（出现多个即 strict 报错——如同时开着消息编辑框）。 */
  const composer = () => page.locator("textarea").filter({ visible: true });
  /**
   * 输入文字到输入框。append=false（默认）先清空原内容；append=true 接在现有内容
   * 之后（如已注入 @[名] 胶囊再补正文）。mode="keys" 逐键真实键入（触发 @/斜杠
   * 等建议弹层）；默认 insert 整段插入。
   */
  const type = async (text, { mode = "insert", append = false } = {}) => {
    const box = composer();
    await box.focus();
    if (!append) await box.fill("");
    await box.press("Control+End");
    if (mode === "keys") await box.pressSequentially(text, { delay: 20 });
    else await page.keyboard.insertText(text);
    return true;
  };
  /** 输入并按回车发送（流式中回车 = 暂存）。 */
  const send = async (text, opts) => {
    lastSendHead = headOf(text);
    await type(text, opts);
    await composer().press("Enter");
    return true;
  };
  /** 回合进行中判定：停止钮在场且可用。
   *  注意：输入框里有文字时，产品把停止钮换成发送钮——等回合的期间别让输入框留着内容。 */
  const turnActive = () => page.locator('button[title="停止"]:not([disabled])').first().isVisible().catch(() => false);
  /**
   * 等回合启动的迹象，超时返回 false：停止钮亮着，或者刚发的那条用户消息后面已经有了助手的回答。
   * 不能只看停止钮——发送之后要等后端的发送调用返回才清空输入框，输入框里有字时产品显示的是发送钮；
   * 回合很短时（快模型一两秒就答完）发送调用要到回合收口才返回，停止钮可能一次都没亮过
   * （收口轮实跑：EC-10 的第一条消息因此被误判成「模型不可用」）。
   * 「刚发的那条」按内容认（send 记下消息开头的几个字），不数消息行数——消息列表按视口窗口渲染，
   * 视图挪动时多渲染出来的旧行会被数成新回合。不是经 send 发出的（打字后自己按回车）调用方把这条
   * 消息的文字传进来（`{ text }`）；传了也对不上的（比如命令会展开成另一段提示词）只看停止钮。
   */
  let lastSendHead = null;
  const headOf = (text) => {
    const head = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 16);
    return head || null;
  };
  const awaitTurnStart = async (timeout = 20000, { text } = {}) => {
    const head = text ? headOf(text) : lastSendHead;
    lastSendHead = null;
    const answered = () =>
      page
        .evaluate((h) => {
          const rows = [...document.querySelectorAll('[data-turn-scope="main"] [data-message-index]')];
          const mine = rows.findLast((r) => r.hasAttribute("data-turn-index") && (r.textContent || "").includes(h));
          return Boolean(mine) && rows.indexOf(mine) < rows.length - 1;
        }, head)
        .catch(() => false);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await turnActive()) return true;
      if (head && (await answered())) return true;
      await sleep(200);
    }
    return false;
  };

  // ── 工具执行审批（v0.9.8 评审修复轮 R2 / 用户裁决 9：同意、不同意各有自动化；默认不替用户表态）──
  /** 审批卡上的三个钮（chat-page.tsx 的审批弹窗；按中文界面定位）。 */
  const APPROVAL_BUTTONS = { deny: "拒绝", once: "仅本次允许", always: "始终允许" };
  /** approvals 三态里要表态的两态 → 点哪个钮。false（默认）不表态。 */
  const APPROVAL_ACTION = { allow: "once", deny: "deny" };
  /** 自动化对审批卡的每一次表态（点了哪个钮 / 按了 Esc、卡上的工具与命令），运行器写进报告。 */
  const approvalLog = [];
  /**
   * 审批卡定位：弹窗里有「仅本次允许」或「始终允许」钮（变更前审批档隐藏后者）。
   * 业务确认卡（能力重叠、卸载确认…）没有这两个钮，不会误中。
   */
  const approvalDialog = () =>
    page.getByRole("dialog").filter({ has: page.getByRole("button", { name: /^(仅本次允许|始终允许)$/ }) });
  /**
   * 读当前审批卡；没有卡返回 null。
   * payload 是卡上 <pre> 里那段 JSON：{ tool, summary, mode, origin }——summary 是工具入参里那句
   * 命令 / 文件路径（后端 jishu-tool-approval 链路拼的），mode 是发卡时的档位。
   */
  const approvalCard = async () => {
    const dlg = approvalDialog().first();
    if (!(await dlg.isVisible().catch(() => false))) return null;
    const raw = (await dlg.locator("pre").first().textContent().catch(() => "")) || "";
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    const buttons = (await dlg.getByRole("button").allTextContents().catch(() => [])).map((s) => s.trim()).filter(Boolean);
    return { payload: payload ?? raw.slice(0, 200), tool: payload?.tool ?? null, summary: payload?.summary ?? null, mode: payload?.mode ?? null, buttons };
  };
  /** 点完 / 按 Esc 之后等这张卡收起（后面若还排着下一张，卡会留着但内容换了）。超时返回 false。 */
  const cardSettled = async (card, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = await approvalCard();
      if (!now) return true;
      if (JSON.stringify(now.payload) !== JSON.stringify(card.payload)) return true;
      await sleep(200);
    }
    return false;
  };
  /**
   * 点审批卡上的一个钮，返回这一下点了什么。只认 "deny"（拒绝）和 "once"（仅本次允许）——
   * 「始终允许」会把这次批准记进用户的审批记忆（持久改动），自动化不点：传 "always" 直接抛错。
   */
  const clickApproval = async (which, by = "case") => {
    if (which === "always") {
      throw new Error('自动化不点「始终允许」——它会把这次批准记进用户的审批记忆。要放行请点「仅本次允许」（"once"）');
    }
    const label = APPROVAL_BUTTONS[which];
    if (!label) throw new Error(`点审批卡：不认识的钮「${String(which)}」（只认 "deny" / "once"）`);
    const card = await approvalCard();
    if (!card) throw new Error("要点审批卡，但屏幕上没有审批卡");
    await approvalDialog().first().getByRole("button", { name: label, exact: true }).click({ timeout: 5000 });
    const settled = await cardSettled(card);
    const item = { button: label, tool: card.tool, summary: card.summary, mode: card.mode, settled };
    approvalLog.push({ at: new Date().toISOString(), by, ...item });
    return item;
  };
  /**
   * 拒绝当前审批卡：按 Esc（= 用户点「拒绝」）。用在「不表态」的场合——等回合时的默认值、
   * 用例之间清残留弹层——都是同一个方向：宁可拒绝，不放行。返回这一下拒绝了哪张卡。
   */
  const rejectApprovalByEscape = async (by, note = "") => {
    const card = await approvalCard();
    if (!card) return null;
    let settled = false;
    for (let attempt = 0; attempt < 3 && !settled; attempt++) {
      await page.keyboard.press("Escape").catch(() => {});
      settled = await cardSettled(card, 4000);
    }
    const item = { button: "Esc（等于拒绝）", tool: card.tool, summary: card.summary, mode: card.mode, settled, note };
    approvalLog.push({ at: new Date().toISOString(), by, ...item });
    return item;
  };
  /**
   * 等审批卡出现。返回 { card }；回合先结束了、或等满了时限都没有卡，返回 { card: null, reason }。
   * 要在确认回合已经启动之后调（停止钮出现过）——回合还没起头时停止钮不在，会被当成「回合已结束」。
   */
  const waitApproval = async (timeoutMs = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const card = await approvalCard();
      if (card) return { card };
      if (!(await turnActive())) {
        await sleep(600); // 两张卡之间可能有一拍空档：再确认一次
        const again = await approvalCard();
        if (again) return { card: again };
        if (!(await turnActive())) return { card: null, reason: "回合已经结束，没有再弹审批卡" };
      }
      await sleep(400);
    }
    return { card: null, reason: `等了 ${Math.round(timeoutMs / 1000)} 秒没有弹审批卡，回合也还没结束` };
  };
  /** approvals 的合法值：false（默认，不表态）/ "allow" / "deny"。别的值直接抛错——旧版的 true（自动放行）不再被接受。 */
  const assertApprovalSetting = (approvals) => {
    if (approvals === false || approvals === "allow" || approvals === "deny") return;
    throw new Error(`waitTurn / waitIdle 的 approvals 只能是 false / "allow" / "deny"，收到 ${JSON.stringify(approvals)}（框架不再自动放行审批，见文件头）`);
  };
  /**
   * 轮询等待时遇到审批卡的处理（waitTurn / waitIdle 共用）。返回处理了哪一张；没有卡返回 null。
   * - setting 为 false（默认）：按 Esc 拒绝并记下——调用方在等待结束时据此让用例失败；
   * - "allow" / "deny"：点对应的钮；"allow" 另可给 approveOnly(card) 划定放行范围，范围之外的卡点「拒绝」并记下。
   */
  const dealWithApproval = async (setting, approveOnly, items, by) => {
    const card = await approvalCard();
    if (!card) return null;
    const which = APPROVAL_ACTION[setting];
    const inScope = typeof approveOnly === "function" ? Boolean(approveOnly(card)) : true;
    let item;
    if (!which) item = { ...(await rejectApprovalByEscape(by, "框架默认不表态")), inScope: false };
    else if (inScope) item = { ...(await clickApproval(which, by)), inScope: true };
    else item = { ...(await clickApproval("deny", by)), inScope: false, note: "不在放行范围内" };
    items.push(item);
    return item;
  };
  /** 默认不表态时遇到了审批卡：等待结束抛这个错（写明每一张卡）。 */
  const unexpectedApprovalsError = (items, where) => {
    const stuck = items.filter((i) => i.settled === false).length;
    return new Error(
      `${where}期间出现了 ${items.length} 张审批卡——框架不替用户放行，已按 Esc 拒绝（与清残留弹层同向）：` +
        JSON.stringify(items.map((i) => ({ 工具: i.tool, 命令: i.summary, 档位: i.mode }))) +
        (stuck ? `；其中 ${stuck} 张按 Esc 没有收起，可能还留在屏幕上` : "") +
        `。这条用例确实需要工具被批准（或被拒绝）才走得完的话，显式传 approvals: "allow"（或 "deny"）并在调用处写明原因`,
    );
  };
  /**
   * 等回合结束：轮询停止钮。期间遇到审批卡怎么办由 approvals 决定（三态，默认 false）：
   *   false    不替用户表态：按 Esc（= 拒绝）并记下每一张；回合结束后抛错说明「出现了 N 张审批卡，
   *            已拒绝、未放行」——用例判失败。审批卡不区分会话，也可能是别的会话弹的，所以报错里带卡上的内容。
   *   "allow"  点「仅本次允许」。给了 approveOnly(card) 时只放行它返回 true 的卡，其余点「拒绝」并记下。
   *   "deny"   点「拒绝」。
   * 「始终允许」任何情况下都不点（见 clickApproval）。返回 { done, ms, approvals: { setting, clicked, button, items } }。
   */
  const waitTurn = async ({ budgetMs = 180000, settleMs = 5000, approvals = false, approveOnly = null, _alive = null } = {}) => {
    assertApprovalSetting(approvals);
    const t0 = Date.now();
    const items = [];
    const finish = (done) => {
      if (approvals === false && items.length) throw unexpectedApprovalsError(items, "等回合");
      return {
        done,
        ms: Date.now() - t0,
        approvals: { setting: approvals, clicked: items.length, button: approvals === false ? null : APPROVAL_BUTTONS[APPROVAL_ACTION[approvals]], items },
      };
    };
    while (Date.now() - t0 < budgetMs) {
      if (_alive && !_alive()) throw new Error("用例已超时，等待终止");
      if (await dealWithApproval(approvals, approveOnly, items, "waitTurn")) continue;
      const active = await turnActive();
      if (!active && Date.now() - t0 > settleMs) return finish(true);
      await sleep(1500);
    }
    return finish(false);
  };
  // 暂存消息（流式中回车排队的消息；排队的压缩命令也在这一区）：拖拽手柄与条目行
  const stagedGrips = () => page.locator('span[draggable][title="拖动调整顺序"]');
  const stagedRows = () => page.locator('div[class*="bg-amber-500/5"]');
  const stagedTexts = () => stagedRows().evaluateAll((els) => els.map((e) => (e.querySelector("p")?.textContent || "").trim()));
  /**
   * 等全部回合真正空闲：连续 stableMs 内既无停止钮也无暂存卡片（暂存投递会在
   * 回合之间立刻起新回合——只看一次「停止钮消失」会误判）。返回 { idle, ms, approvals }。
   * 审批卡的处理与 waitTurn 同一个口径（approvals 三态，默认不表态——遇到了同样让用例失败）；
   * 前两个参数照旧按位置传：waitIdle(4000, 120000)，要表态时第三个参数给 { approvals, approveOnly }。
   */
  const waitIdle = async (stableMs = 6000, budgetMs = 240000, { approvals = false, approveOnly = null, _alive = null } = {}) => {
    assertApprovalSetting(approvals);
    const t0 = Date.now();
    let idleSince = null;
    const items = [];
    const finish = (idle) => {
      if (approvals === false && items.length) throw unexpectedApprovalsError(items, "等空闲");
      return { idle, ms: Date.now() - t0, approvals: { setting: approvals, clicked: items.length, button: approvals === false ? null : APPROVAL_BUTTONS[APPROVAL_ACTION[approvals]], items } };
    };
    while (Date.now() - t0 < budgetMs) {
      if (_alive && !_alive()) throw new Error("用例已超时，等待终止");
      if (await dealWithApproval(approvals, approveOnly, items, "waitIdle")) {
        idleSince = null;
        continue;
      }
      const busy = (await turnActive()) || (await stagedGrips().count()) > 0;
      if (!busy) {
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince >= stableMs) return finish(true);
      } else idleSince = null;
      await sleep(1000);
    }
    return finish(false);
  };

  /** 活动元素画像（纯键盘走查 J12 用）。 */
  const activeInfo = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 60);
      const role = el.getAttribute("role") || (el.tagName === "BUTTON" ? "button" : el.tagName.toLowerCase());
      return { tag: el.tagName, role, name };
    });
  /**
   * 纯键盘定位：反复按 Tab（或 Shift+Tab）直到活动元素的可访问名命中 target
   *（字符串 includes / 正则 / 判断函数），返回 { tabs, tag, role, name }；超 maxTabs 抛错。
   */
  const focusWalkTo = async (target, { maxTabs = 150, key = "Tab" } = {}) => {
    const hit =
      typeof target === "string"
        ? (n) => n.includes(target)
        : typeof target.test === "function"
          ? (n) => target.test(n)
          : target;
    for (let i = 0; i <= maxTabs; i++) {
      const info = await activeInfo();
      if (info && hit(info.name)) return { tabs: i, ...info };
      await page.keyboard.press(key);
    }
    throw new Error(`keyboard walk: ${maxTabs} 次 Tab 内未找到「${String(target).slice(0, 40)}」`);
  };

  /** 附件挂上的稳定信号：输入框占位文案变化（有附件时应用改写占位文案——它是
   * textarea 的属性，不在页面 textContent 里，不能用 waitFor(文本) 判）。 */
  const composerPlaceholder = () => composer().getAttribute("placeholder");
  const waitAttached = (placeholderBefore, timeoutMs = 8000) =>
    page
      .waitForFunction(
        (ph) => {
          const ta = [...document.querySelectorAll("textarea")].find((t) => t.getBoundingClientRect().height > 0);
          return !!ta && ta.placeholder !== ph;
        },
        placeholderBefore,
        { timeout: timeoutMs, polling: 300 },
      )
      .then(() => true, () => false);
  /** 剪贴板里那类内容的中文说法（报告里用）。 */
  const CLIPBOARD_KIND_TEXT = { image: "图片", files: "文件", other: "非文本的内容（富文本、位图以外的格式）", text: "文字", empty: "（空）" };
  /** 剪贴板原文字的 base64 超过这个长度就不占用：还原要把整段文字塞进 PowerShell 命令行，太长塞不下、保证不了原样放回。 */
  const CLIPBOARD_RESTORE_LIMIT = 6000;
  /**
   * 读系统剪贴板现在装的是什么（只读，不动它）。返回 { kind, text }：
   * - kind：image（图片）/ files（复制的文件）/ other（有内容但不是文字）/ text（纯文字）/ empty（空）；
   * - text：文字内容的 base64（UTF-8），没有文字就是空串。
   * 读不出来（被别的进程占着）返回 null。
   */
  const probeClipboard = async () => {
    const out = await runPowerShell(
      "Add-Type -AssemblyName System.Windows.Forms; " +
        "try { " +
        "$t = Get-Clipboard -Raw -ErrorAction SilentlyContinue; " +
        "$b64 = ''; if ($null -ne $t) { $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }; " +
        "$n = 0; $d = [System.Windows.Forms.Clipboard]::GetDataObject(); if ($null -ne $d) { $n = @($d.GetFormats()).Count }; " +
        "$kind = 'text'; " +
        "if ([System.Windows.Forms.Clipboard]::ContainsImage()) { $kind = 'image' } " +
        "elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { $kind = 'files' } " +
        "elseif ($null -eq $t -and $n -gt 0) { $kind = 'other' } " +
        "elseif ($null -eq $t -or $b64 -eq '') { $kind = 'empty' }; " +
        "'{0}|{1}' -f $kind, $b64 " +
        "} catch { exit 3 }",
    ).catch(() => null);
    if (out === null) return null;
    const bar = out.indexOf("|");
    if (bar < 0) return null;
    const kind = out.slice(0, bar).trim().toLowerCase();
    if (!(kind in CLIPBOARD_KIND_TEXT)) return null;
    return { kind, text: out.slice(bar + 1).trim() };
  };
  /**
   * 附件——真人路径：把文件放进系统剪贴板（同资源管理器「复制」）→ 输入框 Ctrl+V。
   * 输入框没有 <input type=file>（附件菜单走系统原生对话框，浏览器自动化够不着）；
   * chat-input 的粘贴处理明确支持「OS 文件复制」这条用户路径（实测：可信 paste 事件，
   * clipboardData.files 1 项）。仅 Windows。
   *
   * 系统剪贴板是用户的——评审修复轮 R2 起的规矩：
   * - 先看里面是什么。图片、文件、别的非文本格式、或者读不出来（被别的进程占着）→ **不占用**，
   *   返回 attached: false 并写明原因（调用方回落到合成粘贴事件）；只有空剪贴板或纯文字才占用；
   * - 占用后一定还原（Ctrl+V 那一步抛错也走还原），并且**读回**：读回来的与占用前一致才算「已还原」。
   * 返回 { attached, ms, clipboardRestored, clipboardUntouched, reason?, placeholder }。
   */
  const attachByClipboard = async (filePath, { timeoutMs = 8000 } = {}) => {
    if (process.platform !== "win32") return { attached: false, ms: 0, clipboardRestored: false, clipboardUntouched: true, reason: "仅 Windows" };
    const abs = filePath.replace(/\//g, "\\").replace(/'/g, "''");
    const ph0 = await composerPlaceholder();
    const before = await probeClipboard();
    const skip = (reason) => ({ attached: false, ms: 0, clipboardRestored: false, clipboardUntouched: true, reason, placeholder: ph0 });
    if (!before) return skip("读不出系统剪贴板里的内容（可能被别的进程占用），不覆盖它");
    if (before.kind !== "text" && before.kind !== "empty") return skip(`系统剪贴板里是${CLIPBOARD_KIND_TEXT[before.kind]}，不覆盖它`);
    if (before.text.length > CLIPBOARD_RESTORE_LIMIT) return skip("系统剪贴板里的文字太长，保证不了原样放回，不覆盖它");
    const saved = before.text;
    /** 还原并读回。占用前是空的 → 清空；是文字 → 放回原文。剪贴板可能被别的进程短暂占用，失败重试，最多 3 次。 */
    const restoreClipboard = async () => {
      // 清空剪贴板用 .NET 的 Clipboard.Clear——Windows PowerShell 5.1 没有 Clear-Clipboard 这个命令
      //（2026-11-24 实录：命令不存在，演示图文件留在了用户的剪贴板上）
      const command =
        saved === ""
          ? "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()"
          : `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${saved}')))`;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await runPowerShell(command).then(() => true, () => false)) {
          const back = await probeClipboard();
          if (back && back.kind === before.kind && back.text === saved) return true;
        }
        await sleep(600);
      }
      return false;
    };
    await runPowerShell(`Set-Clipboard -Path '${abs}'`).catch(() => {
      throw Object.assign(new Error("系统剪贴板被占用，放不进文件"), { clipboardUntouched: true });
    });
    // 剪贴板已经被改掉：从这里开始无论成败都要走还原
    const t0 = Date.now();
    let attached = false;
    let clipboardRestored = false;
    try {
      await composer().focus();
      await page.keyboard.press("Control+V");
      // 剪贴板在「挂上判定完成之后」才还原——后端要读剪贴板里的文件路径。
      attached = await waitAttached(ph0, timeoutMs);
    } catch (e) {
      e.clipboardRestored = await restoreClipboard();
      throw e;
    }
    clipboardRestored = await restoreClipboard();
    return { attached, ms: Date.now() - t0, clipboardRestored, clipboardUntouched: false, placeholder: await composerPlaceholder() };
  };
  /**
   * 附件——合成兜底：直接派发带 DataTransfer 的 paste 事件（非可信事件，但走应用同一条
   * 粘贴处理链）。仅在无法操作系统剪贴板的环境使用。
   */
  const attachByPasteEvent = async (filePath, { name, mime } = {}) => {
    const ph0 = await composerPlaceholder();
    const b64 = fs.readFileSync(filePath).toString("base64");
    const fname = name || path.basename(filePath);
    await composer().focus();
    await page.evaluate(
      async ([data, filename, type]) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], filename, { type }));
        const evt = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(evt, "clipboardData", { value: dt });
        document.querySelector("textarea").dispatchEvent(evt);
      },
      [b64, fname, mime || "image/png"],
    );
    return waitAttached(ph0, 8000);
  };

  /** 截图（原始 CDP 抓取：视口尺寸 = 仿真视口，PNG）。路径用正斜杠。 */
  const shot = async (filename) => {
    const file = filename.replace(/\\/g, "/");
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    fs.mkdirSync(dir, { recursive: true });
    if (cdp) {
      const r = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    } else {
      await page.screenshot({ path: file, scale: "css" });
    }
    log("shot:", file.slice(file.lastIndexOf("/") + 1));
    return file;
  };

  /** 断开连接（connectOverCDP 语义下只断开、不关应用）；清除视口仿真还原窗口。 */
  const close = async () => {
    await setViewport(null).catch(() => {});
    await cdp?.detach().catch(() => {});
    await browser.close().catch(() => {});
  };

  const api = {
    browser,
    context,
    page,
    cdp,
    errors,
    log,
    sleep,
    runPowerShell,
    ev,
    evj,
    invoke,
    bodyText,
    waitFor,
    gone,
    isChineseUI,
    assertLanding,
    navClick,
    click,
    clickText,
    clickTitle,
    sidebar,
    sidebarProjectName,
    currentProjectName,
    pinnedProjectLabels,
    listSessionTitles,
    sessionHeader,
    headerIdText,
    waitSessionResolved,
    openSession,
    switchProject,
    cancelResidualDialog,
    ensureWorkspace,
    newConversation,
    clearComposerLeftover,
    dismiss,
    plusMenu,
    agentSwitchTitle,
    closeGuideCards,
    openMarket,
    taskRows,
    taskRecords,
    openTaskRow,
    rowState,
    waitRowState,
    projectInfo,
    sessionFullId,
    createTaskViaGui,
    waitGraphRun,
    chatAgentId,
    readToolMode,
    accessMode,
    accessModeOptions,
    setAccessMode,
    composer,
    type,
    send,
    turnActive,
    awaitTurnStart,
    approvalDialog,
    approvalCard,
    clickApproval,
    waitApproval,
    approvalLog,
    waitTurn,
    stagedGrips,
    stagedRows,
    stagedTexts,
    waitIdle,
    activeInfo,
    focusWalkTo,
    attachByClipboard,
    attachByPasteEvent,
    probeClipboard,
    setViewport,
    shot,
    close,
  };

  /**
   * 轮询等待方法里「用例是否还活着」这个参数在各自签名的第几位（waitTurn / waitIdle 走选项对象里的 _alive，不在此列）。
   * 必须按位置放，不能一律追加到末尾：用例只传运行号调 waitGraphRun 时，追加会把它放进「超时时长」那一位——
   * 截止时刻算出 NaN，等待循环一轮不跑就返回空表，用例以为节点都跑完了（tasksession 场景包 TS-4 首跑实跑踩到）。
   */
  const ALIVE_AT = { waitRowState: 3, waitGraphRun: 2, waitSessionResolved: 1 };

  /**
   * 给单个用例用的驱动视图（运行器每条用例调一次）——用例超时后「终止」它靠这个：
   * - expire() 之后，这条用例再调任何驱动方法都立即抛「用例已超时，后续操作不再执行」；
   * - 正在进行的轮询等待（waitTurn / waitIdle / waitRowState / waitGraphRun / waitSessionResolved）
   *   在下一轮循环里抛「用例已超时，等待终止」——不会带着界面操作（例如按 Esc 关审批卡）活到下一条用例；
   * - 其它属性（page、log、errors、approvalLog…）原样透出。
   * 返回 { app, expire, alive }：expire() 之后 alive() 为假——运行器用它把 ctx 上的助手也一并挡下。
   */
  api.forCase = () => {
    const lease = { expired: false };
    const alive = () => !lease.expired;
    const guarded = new Proxy(api, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args) => {
          if (lease.expired) throw new Error("用例已超时，后续操作不再执行");
          if (prop === "waitTurn") args[0] = { ...(args[0] || {}), _alive: alive };
          else if (prop === "waitIdle") args[2] = { ...(args[2] || {}), _alive: alive };
          else if (prop in ALIVE_AT) {
            // 中间没传的可选参数留空位（undefined），方法自己的默认值照常生效
            while (args.length < ALIVE_AT[prop]) args.push(undefined);
            args[ALIVE_AT[prop]] = alive;
          }
          return value.apply(target, args);
        };
      },
    });
    return { app: guarded, expire: () => { lease.expired = true; }, alive: () => !lease.expired };
  };

  log(`attached: ${page.url()} (${Date.now() - t0}ms) viewport=${viewport ? `${viewport.width}x${viewport.height}` : "native"}`);
  return api;
}
