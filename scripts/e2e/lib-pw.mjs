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
 */
export function readSessionUsers(shortId, sinceMs = 0) {
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
  for (const line of fs.readFileSync(hits[0], "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o.message || {};
    if (m.role !== "user" && m.role !== "assistant") continue;
    const c = m.content;
    const texts = typeof c === "string" ? [c] : (c || []).filter((b) => b && b.type === "text").map((b) => b.text || "");
    const raw = texts.join("\n");
    if (m.role === "user") rawUsers.push(raw);
    sequence.push({ role: m.role, text: clean(raw).replace(/\n+/g, " ").slice(0, 40) });
    for (let t of texts) {
      t = clean(t).replace(/\n+/g, " ");
      if (!t) continue;
      if (m.role === "user") users.push(t);
      else assistants.push(t.slice(0, 120));
    }
  }
  return { file: path.basename(hits[0]), users, assistants, rawUsers, sequence };
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
  // 页面发现：Tauri 单窗口；过滤 devtools:// 目标；URL 兼容生产 tauri.localhost 与 dev localhost:1420。
  let page = null;
  const deadline = Date.now() + 10000;
  while (!(page = context.pages().find((p) => !p.url().startsWith("devtools")))) {
    if (Date.now() > deadline) {
      await browser.close();
      throw new Error(`10s 内未发现 page target（${CDP_ENDPOINT}/json/list）`);
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
  const waitSessionResolved = async (timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    let id = "";
    while (Date.now() < deadline) {
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
   * 返回被关闭的弹层文本，无弹层返回 null。
   */
  const cancelResidualDialog = async () => {
    let lastText = null;
    // 弹层可能叠着（上一用例中途失败常留一个）：逐个关，最多 3 层
    for (let layer = 0; layer < 3; layer++) {
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
  const waitRowState = async (row, wanted, timeout) => {
    const deadline = Date.now() + timeout;
    let last = "idle";
    while (Date.now() < deadline) {
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
   * 造一个带任务图的任务：建图 → 加几个「派发给智能体」的节点（前后依赖，依次执行）→ 启动执行
   * → 用这张图建任务实例。节点执行时各自产生一个子会话，任务看板上就能点进去看。
   * 图、任务实例、节点会话都留在项目里。返回 { taskId, graphId, runId, projectRoot, encodedName }。
   * nodes: [{ nodeId, title, prompt }]
   */
  const createGraphTask = async ({ title, nodes }) => {
    const project = await projectInfo();
    if (!project) throw new Error("认不出当前项目，没法建任务图");
    const projectRoot = project.path;
    const created = await invoke("orchestrator_create_graph", {
      input: { title, goal: title, project_root: projectRoot, owner: "e2e" },
    });
    const graph = Array.isArray(created) ? created[0] : created.graph;
    const revision = Array.isArray(created) ? created[1] : created.revision;
    const noTools = {
      approval_policy: "never",
      permission_scope: { can_read_files: false, can_write_files: false, can_run_commands: false, can_access_network: false, can_deploy: false },
    };
    const commands = nodes.map((n, i) => ({
      op: "add_node",
      command_id: `cmd-node-${i}`,
      node: {
        node_id: n.nodeId,
        parent_id: "goal",
        title: n.title,
        description: n.title,
        node_kind: "executable",
        input_contract: { description: null, artifacts: [], schema: null },
        output_contract: { description: n.title, artifacts: [], schema: null },
        role_requirement: { role_id: "implementer", responsibility: n.title, required_capabilities: [], preferred_capabilities: [] },
        capability_requirements: [],
        agent_assignment_constraint: null,
        policy: noTools,
        metadata: {},
        executable_payload: { type: "dispatch", role_id: "implementer", prompt: n.prompt, project: null, session: null },
        loop_config: null,
        approval_gate_config: null,
      },
    }));
    for (let i = 1; i < nodes.length; i++) {
      commands.push({
        op: "add_edge",
        command_id: `cmd-edge-${i}`,
        edge: { edge_id: `edge-${i}`, source_node_id: nodes[i - 1].nodeId, target_node_id: nodes[i].nodeId, kind: "control_dependency" },
      });
    }
    const applied = await invoke("orchestrator_apply_commands", {
      graphId: graph.graph_id,
      expectedRevisionId: revision.revision_id,
      commands,
      author: "e2e",
    });
    const revisionId = applied?.revision?.revision_id ?? applied?.revision_id;
    const run = await invoke("orchestrator_start_run", { graphId: graph.graph_id, revisionId });
    const instance = await invoke("task_launch_create_from_existing_graph", {
      projectRoot,
      graphId: graph.graph_id,
      title,
      skillId: "jishu-task-runner",
    });
    return { taskId: instance.task_id, graphId: graph.graph_id, runId: run.run_id, projectRoot, encodedName: project.encoded_name };
  };

  /**
   * 等一次执行里所有节点都跑完。返回 [{ nodeId, status, sessionId, agentId }]；超时返回当时的状态。
   * sessionId 是这个节点那一轮执行产生的子会话。
   */
  const waitGraphRun = async (runId, timeout = 240000) => {
    const done = new Set(["succeeded", "failed", "cancelled", "canceled", "skipped"]);
    const deadline = Date.now() + timeout;
    let runs = [];
    while (Date.now() < deadline) {
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

  /** 把一个会话挂成任务的主会话（任务工作台一打开显示的就是它）。 */
  const attachTaskMainSession = async ({ taskId, sessionId, title }) => {
    const project = await projectInfo();
    if (!project) throw new Error("认不出当前项目，没法挂主会话");
    return invoke("task_launch_mark_session", { projectRoot: project.path, taskId, sessionId, skillId: "jishu-task-runner", title });
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
    await type(text, opts);
    await composer().press("Enter");
    return true;
  };
  /** 回合进行中判定：停止钮在场且可用。 */
  const turnActive = () => page.locator('button[title="停止"]:not([disabled])').first().isVisible().catch(() => false);
  /**
   * 等回合结束：轮询停止钮；期间自动点审批钮（总是允许/允许）。
   * 返回 { done, ms, approvals }。
   */
  const waitTurn = async ({ budgetMs = 180000, settleMs = 5000, approvals = true } = {}) => {
    const t0 = Date.now();
    let clicked = 0;
    while (Date.now() - t0 < budgetMs) {
      if (approvals) {
        const btn = page.getByRole("button", { name: /总是允许|允许|批准/ }).filter({ hasNotText: /拒绝|否/ });
        const n = await btn.count();
        for (let i = 0; i < n; i++) {
          const b = btn.nth(i);
          if (await b.isVisible().catch(() => false)) {
            await b.click({ timeout: 2000 }).catch(() => {});
            clicked++;
            break;
          }
        }
      }
      const active = await turnActive();
      if (!active && Date.now() - t0 > settleMs) return { done: true, ms: Date.now() - t0, approvals: clicked };
      await sleep(1500);
    }
    return { done: false, ms: Date.now() - t0, approvals: clicked };
  };
  // 暂存消息（流式中回车排队的消息）：拖拽手柄与条目行
  const stagedGrips = () => page.locator('span[draggable][title="拖动调整顺序"]');
  const stagedRows = () => page.locator('div[class*="bg-amber-500/5"]');
  const stagedTexts = () => stagedRows().evaluateAll((els) => els.map((e) => (e.querySelector("p")?.textContent || "").trim()));
  /**
   * 等全部回合真正空闲：连续 stableMs 内既无停止钮也无暂存卡片（暂存投递会在
   * 回合之间立刻起新回合——只看一次「停止钮消失」会误判）。返回 { idle, ms }。
   */
  const waitIdle = async (stableMs = 6000, budgetMs = 240000) => {
    const t0 = Date.now();
    let idleSince = null;
    while (Date.now() - t0 < budgetMs) {
      const busy = (await turnActive()) || (await stagedGrips().count()) > 0;
      if (!busy) {
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince >= stableMs) return { idle: true, ms: Date.now() - t0 };
      } else idleSince = null;
      await sleep(1000);
    }
    return { idle: false, ms: Date.now() - t0 };
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
  /**
   * 附件——真人路径：把文件放进系统剪贴板（同资源管理器「复制」）→ 输入框 Ctrl+V。
   * 输入框没有 <input type=file>（附件菜单走系统原生对话框，浏览器自动化够不着）；
   * chat-input 的粘贴处理明确支持「OS 文件复制」这条用户路径（实测：可信 paste 事件，
   * clipboardData.files 1 项）。仅 Windows。
   * 副作用：占用系统剪贴板——原内容若为文本，附件挂上后还原；非文本内容无法还原。
   * 返回 { attached, ms, clipboardRestored }。
   */
  const attachByClipboard = async (filePath, { timeoutMs = 8000 } = {}) => {
    if (process.platform !== "win32") return { attached: false, ms: 0, clipboardRestored: false, reason: "仅 Windows" };
    const abs = filePath.replace(/\//g, "\\").replace(/'/g, "''");
    const ph0 = await composerPlaceholder();
    const saved = await runPowerShell(
      "$t = Get-Clipboard -Raw -ErrorAction SilentlyContinue; if ($null -ne $t) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) } else { '' }",
    ).catch(() => null);
    await runPowerShell(`Set-Clipboard -Path '${abs}'`);
    const t0 = Date.now();
    await composer().focus();
    await page.keyboard.press("Control+V");
    // 剪贴板在「挂上判定完成之后」才还原——后端要读剪贴板里的文件路径。
    const attached = await waitAttached(ph0, timeoutMs);
    // 清空剪贴板用 .NET 的 Clipboard.Clear——Windows PowerShell 5.1 没有 Clear-Clipboard
    // 这个命令（2026-11-24 实录：剪贴板原本没有文字时还原走到它，命令不存在，演示图
    // 文件留在了用户的剪贴板上）。剪贴板可能被别的进程短暂占用，还原失败重试，最多 3 次。
    const restore = async () => {
      if (saved === null) return false;
      const command = saved === ""
        ? "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()"
        : `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${saved}')))`;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await runPowerShell(command).then(() => true, () => false)) return true;
        await sleep(600);
      }
      return false;
    };
    const clipboardRestored = await restore();
    return { attached, ms: Date.now() - t0, clipboardRestored, placeholder: await composerPlaceholder() };
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

  log(`attached: ${page.url()} (${Date.now() - t0}ms) viewport=${viewport ? `${viewport.width}x${viewport.height}` : "native"}`);
  return {
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
    createGraphTask,
    waitGraphRun,
    attachTaskMainSession,
    composer,
    type,
    send,
    turnActive,
    waitTurn,
    stagedGrips,
    stagedRows,
    stagedTexts,
    waitIdle,
    activeInfo,
    focusWalkTo,
    attachByClipboard,
    attachByPasteEvent,
    setViewport,
    shot,
    close,
  };
}
