/**
 * 积木：v0.9.8 需求23 搜索体验优化 + 补充轮（SE-1~SE-13）；评审修复轮 R2 补工具标签两块（SE-14、SE-15）。
 * 对应需求文档 docs/v0.9.8/需求23-搜索体验优化/（02 实施与验证、03 补充轮、tests/06 测试清单）。
 * 工具标签两块对应用户裁决 8：「把标签放进容器内，标签的格式可以直接搜」。
 *
 * 三类积木：
 * - 不需要模型（SE-1~SE-3、SE-7、SE-8、SE-11、SE-13、SE-15）：在当前项目已有的会话上量，项目里没有会话就跳过。
 * - 需要模型（SE-4~SE-6、SE-9、SE-10、SE-12）：首次用到时新建一个测试会话，连发三条消息——第 1、3 条
 *   带同一个独一无二的词（「蓝鲸 + 6 位编号」），第 2 条不带；第 3 条让模型回一个 Markdown 表格，
 *   表格最后一行也带这个词。搜这个词只会命中这个测试会话。测试会话留在项目里不删。SE-12 再往
 *   这个会话里发一条带另一个新词的消息——验证侧栏搜索的数据跟着刚聊完的内容走。
 * - 工具标签（评审修复轮 R2）：SE-14 自己造一条「正文里带工具字样」的消息（内联形态，要模型）；
 *   SE-15 在项目已有的会话里找「正文没有工具字样、标签跟在正文之后」的历史消息（尾随形态，不要模型）。
 *   尾随形态没有可靠的自动化造数（它来自旧版本的剥离消息和任务启动包装），SE-15 找不到就标跳过并写明。
 *
 * 回复故意要长：搜索态里只留命中行，命中行加起来得比视口高，「打开会话落在哪」「退出搜索后正在
 * 看的那行在不在原处」才会真的滚动、才量得出来（会话太短时视图不动，怎么测都过）。前提不成立
 * 时这两块标跳过并写明原因，不冒充通过。
 *
 * 「字底是否被裁」怎么量：侧栏这类文字的写法是「行高 = 字号 + 超出隐藏」，裁切线就是裁切盒子的
 * 底边。用页面自己的字体度量算出字形下沿（基线 + 文字实际下沿），和裁切线比；下沿超过裁切线
 * 就是字底被裁。数字与显示缩放无关（都按逻辑像素算）。
 */
import { expect } from "../lib-pw.mjs";
import { pickInjectableTool, reloadIntoSession } from "./fix-round.mjs";

const searchBox = (app) => app.sidebar().locator("input").first();
/** 侧栏的常规会话行（标题带完整标题提示的那一类；任务会话树的行不在此列）。 */
const sessionRows = (app) => app.sidebar().locator("button.flex-col.items-start").filter({ has: app.page.locator("span.truncate[title]") });
const messageRows = (page) => page.locator('[data-turn-scope="main"] [data-message-index]');
const gapBars = (page) => page.locator('[data-turn-scope="main"] [data-search-gap]');

/** 量一组文字的字底是否被裁（在页面里执行，必须自给自足）。scope: "rows"=会话标题 / "others"=侧栏其他文字。 */
const measureClip = ({ scope }) => {
  const sidebar = document.querySelector(".chat-sidebar");
  if (!sidebar) return [];
  const inRow = (el) => Boolean(el.closest("button.flex-col.items-start"));
  const spans = [...sidebar.querySelectorAll("span.truncate")].filter((el) => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    if (scope === "rows" ? !inRow(el) : inRow(el)) return false;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== "hidden") return false;
    const fontSize = parseFloat(cs.fontSize);
    const lineHeight = cs.lineHeight === "normal" ? NaN : parseFloat(cs.lineHeight);
    return Number.isFinite(lineHeight) && Math.abs(lineHeight - fontSize) < 0.6;
  });
  return spans.map((el) => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const metrics = ctx.measureText(el.textContent || " ");
    const ascent = metrics.fontBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent;
    const lineHeight = parseFloat(cs.lineHeight);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    // 行框在字体内容区里居中 → 基线位置；字形下沿 = 基线 + 文字的实际下沿。
    // 裁切线是内边距盒的底边（= 盒子底边往上一条边框）——下内边距在裁切范围以内，
    // 所以留出来的余量算在裁切线以下，正好用来放字的下沿。
    const baseline = rect.top + padTop + (lineHeight - (ascent + descent)) / 2 + ascent;
    const inkBottom = baseline + metrics.actualBoundingBoxDescent;
    const clipBottom = rect.bottom - (parseFloat(cs.borderBottomWidth) || 0);
    const holder = el.closest("[title]");
    return {
      文字: (el.textContent || "").replace(/\s+/g, " ").slice(0, 14),
      归属: holder && holder !== el ? (holder.getAttribute("title") || "").slice(0, 8) : "会话标题",
      字号: cs.fontSize,
      底部余量: cs.paddingBottom,
      字底超出裁切线: +(inkBottom - clipBottom).toFixed(2),
    };
  });
};

/** 命中计数（形如 1/7；在侧栏搜索框右侧的浮层里，只在搜索且打开着会话时出现）；没有返回 null。 */
const counter = (page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll(".chat-sidebar span")].find(
      (node) => node.children.length === 0 && /^\d+\/\d+$/.test((node.textContent || "").trim()),
    );
    return el ? el.textContent.trim() : null;
  });

/** 正文里黄底的处数：命中层 + 当前层（当前那一处单独一层）。 */
const highlightCounts = (page) =>
  page.evaluate(() => {
    const size = (name) => {
      const h = CSS.highlights?.get(name);
      if (!h) return 0;
      let n = 0;
      for (const _ of h) n++;
      return n;
    };
    return size("jishu-search-match") + size("jishu-search-current");
  });

/** 侧栏会话列表加载出来（刚附着上去时列表还没到）；返回会话行数（项目里没有会话就是 0）。 */
const waitForSessionList = async (app) => {
  await sessionRows(app).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  return sessionRows(app).count();
};

/** 徽标上的命中数。 */
const rowBadge = async (row) =>
  Number(((await row.locator("span.rounded-full").filter({ hasText: /^\s*\d+\s*$/ }).first().textContent()) || "").trim());

/** 当前命中（高亮层里那一处）的文字、所在行、是否在视口里。 */
const currentMatch = (page) =>
  page.evaluate(() => {
    const highlight = typeof CSS !== "undefined" && CSS.highlights ? CSS.highlights.get("jishu-search-current") : undefined;
    const scrollerOf = (start) => {
      let el = start;
      while (el && el !== document.body) {
        if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
        el = el.parentElement;
      }
      return null;
    };
    const main = document.querySelector('[data-turn-scope="main"]');
    const scroller = main ? scrollerOf(main) : null;
    if (!scroller) return null;
    const box = scroller.getBoundingClientRect();
    const view = {
      scrollTop: Math.round(scroller.scrollTop),
      atBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) <= 2,
      内容高: Math.round(scroller.scrollHeight),
      视口高: Math.round(scroller.clientHeight),
    };
    if (!highlight) return { ...view, text: null, inView: null };
    for (const range of highlight) {
      const probe = document.createRange();
      probe.setStart(range.startContainer, range.startOffset);
      probe.setEnd(range.endContainer, range.endOffset);
      const rect = probe.getBoundingClientRect();
      const row = range.startContainer.parentElement?.closest("[data-message-index]");
      return {
        ...view,
        text: probe.toString(),
        row: row ? Number(row.getAttribute("data-message-index")) : null,
        inView: rect.top >= box.top && rect.bottom <= box.bottom,
      };
    }
    return { ...view, text: null, inView: null };
  });

/** 视口顶上那条消息行的行号与它离视口顶的距离。 */
const topRow = (page) =>
  page.evaluate(() => {
    const main = document.querySelector('[data-turn-scope="main"]');
    let el = main;
    while (el && el !== document.body) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) break;
      el = el.parentElement;
    }
    if (!main || !el || el === document.body) return null;
    const top = el.getBoundingClientRect().top;
    for (const row of main.querySelectorAll("[data-message-index]")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= top) continue;
      return { row: Number(row.getAttribute("data-message-index")), offset: Math.round(rect.top - top) };
    }
    return null;
  });

const rowOffset = (page, index) =>
  page.evaluate((idx) => {
    const main = document.querySelector('[data-turn-scope="main"]');
    let el = main;
    while (el && el !== document.body) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) break;
      el = el.parentElement;
    }
    const row = main?.querySelector(`[data-message-index="${idx}"]`);
    return row && el ? Math.round(row.getBoundingClientRect().top - el.getBoundingClientRect().top) : null;
  }, index);

const assertNotClipped = (measured, what) => {
  const clipped = measured.filter((item) => item.字底超出裁切线 > 0.5);
  if (clipped.length) {
    throw new Error(`${what}有 ${clipped.length} 处字底被裁：` + clipped.map((item) => `「${item.文字}」超出 ${item.字底超出裁切线}px`).join("；"));
  }
};

async function settle(ctx) {
  const { app } = ctx;
  await app.ensureWorkspace();
  await app.cancelResidualDialog();
  await searchBox(app).fill("");
  await app.sleep(600);
}

/** 新建一个测试会话并连发三条消息，使它可搜索（见文件头）。 */
async function ensureFixture(ctx) {
  if (ctx.state.searchFixture) return ctx.state.searchFixture;
  if (ctx.state.modelOk === false) ctx.skip("模型不可用（本轮已判定）");
  const { app, page } = ctx;
  await settle(ctx);
  await app.closeGuideCards();
  await app.newConversation();
  ctx.state.sessionsCreated += 1;
  const nonce = String(Date.now()).slice(-6);
  const token = `蓝鲸${nonce}`;
  const turns = [
    `这是一条搜索验证消息。请记住这个词：「${token}」。然后用 Markdown 有序列表列出 30 座灯塔，每座后面用一句不少于 15 字的话介绍。`,
    "第二个问题：用一段不少于 80 字的话说说海风。只回复这一段话，不要提别的内容。",
    `第三个问题：请用 Markdown 表格列出 15 样海边的东西，两列：名称、一句不少于 20 字的说明。名称的最后一行写「${token}」。只回复这个表格，不要其他文字。`,
  ];
  for (const [i, text] of turns.entries()) {
    await app.send(text);
    const started = await app.awaitTurnStart(20000);
    if (!started) {
      ctx.state.modelOk = false;
      ctx.skip(`模型不可用：第 ${i + 1} 条消息发出后 20 秒内回合未启动`);
    }
    // approvals 用框架默认值（不表态）：这几条提示词都只要求回复文字，不该出现审批卡；真弹了用例失败并写明
    const turn = await app.waitTurn({ budgetMs: 180000, settleMs: 4000 });
    if (!turn.done) throw new Error(`第 ${i + 1} 条消息的回合没有在时限内结束`);
    const idle = await app.waitIdle(3000, 120000);
    if (!idle.idle) throw new Error("回合结束后没有进入空闲");
  }
  ctx.state.modelOk = true;
  const head = await app.sessionHeader();
  if (!head) throw new Error("读不到测试会话的会话头");
  ctx.state.searchFixture = { nonce, token, shortId: head.id };
  return ctx.state.searchFixture;
}

/** 不搜索时打开测试会话：逐个点最靠前的几行，正文里出现那个独一无二的词就是对的那条。 */
async function openFixtureNormally(ctx) {
  const fixture = await ensureFixture(ctx);
  const { app, page } = ctx;
  await searchBox(app).fill("");
  await app.sleep(800);
  const total = await sessionRows(app).count();
  for (let i = 0; i < Math.min(total, 4); i++) {
    await sessionRows(app).nth(i).click();
    await app.sleep(1500);
    if ((await page.locator('[data-turn-scope="main"]').textContent())?.includes(fixture.token)) {
      const head = await app.sessionHeader();
      if (head?.id !== fixture.shortId) throw new Error("落点不对：标题里的会话不是测试会话");
      return fixture;
    }
  }
  throw new Error("侧栏最靠前的 4 个会话里没找到测试会话");
}

/** 搜索结果里的测试会话那一行。按命中的词定位：搜索结果行一定带着这个词（摘要里就是命中的那一段）。 */
const fixtureRow = (ctx, text = ctx.state.searchFixture.token) => {
  const { app } = ctx;
  return sessionRows(app).filter({ hasText: text }).first();
};

/** 输入搜索词后侧栏的过滤有一拍延迟——等列表稳定再断言（否则会在延迟那一拍里误认「行出现了」）。 */
const searchAndWait = async (app, text) => {
  await searchBox(app).fill(text);
  await app.sleep(1200);
};

/** 输入关键词并点开测试会话（搜索视角）；返回当时的计数与侧栏徽标。 */
async function searchAndOpen(ctx) {
  const fixture = await ensureFixture(ctx);
  const { app, page } = ctx;
  await searchBox(app).fill("");
  await app.sleep(600);
  await searchAndWait(app, fixture.token);
  const row = fixtureRow(ctx);
  await expect(row).toBeVisible({ timeout: 8000 });
  // 徽标 = 圆角标签里文字是一个数字的那个（行首的未读 / 进行中小圆点也是圆角，但没有文字）
  const badge = await rowBadge(row);
  await row.click();
  await app.sleep(1800);
  const head = await app.sessionHeader();
  if (head?.id !== fixture.shortId) throw new Error("点搜索结果后落点不对：不是测试会话");
  return { badge, counter: await counter(page), match: await currentMatch(page) };
}

/** 「进入会话」之后的界面事实：搜索框已清空、侧栏恢复全部会话、正文没有细条、落点校验。 */
async function enteredFacts(ctx, sidebarRowsBefore) {
  const { app, page } = ctx;
  await expect(searchBox(app)).toHaveValue("", { timeout: 5000 });
  await expect(gapBars(page)).toHaveCount(0, { timeout: 8000 });
  await app.sleep(600);
  const head = await app.sessionHeader();
  if (head?.id !== ctx.state.searchFixture.shortId) throw new Error("进入的不是测试会话");
  const rows = await sessionRows(app).count();
  if (rows !== sidebarRowsBefore) throw new Error(`侧栏会话行数没恢复：进入前 ${sidebarRowsBefore}，进入后 ${rows}`);
  return { 搜索框: await searchBox(app).inputValue(), 侧栏会话行数: rows, 正文行数: await messageRows(page).count(), 细条: await gapBars(page).count(), 会话头: head.id };
}

// 每块收尾：清空搜索框、关掉可能开着的右键菜单——用例中途失败时不把搜索态留给下一块
const withCleanup = (c) => ({
  ...c,
  run: async (ctx) => {
    try {
      return await c.run(ctx);
    } finally {
      await ctx.page.keyboard.press("Escape").catch(() => {});
      await searchBox(ctx.app).fill("").catch(() => {});
    }
  },
});

/**
 * 主线程占用量（SE-13）：长任务（浏览器记的「一次占住主线程超过 50 毫秒」）与两帧之间的间隔。
 * 长任务是浏览器自己记的，窗口在后台也准；帧间隔在窗口被完全挡住时会被浏览器拉长，只作旁证。
 */
const perfStart = (page) =>
  page.evaluate(() => {
    const s = (window.__se13 = { start: performance.now(), tasks: [], frames: [], raf: 0, ob: null });
    try {
      s.ob = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) s.tasks.push({ start: e.startTime, dur: e.duration });
      });
      s.ob.observe({ entryTypes: ["longtask"] });
    } catch {
      /* 不支持长任务观测时只看帧间隔 */
    }
    const tick = (t) => {
      s.frames.push(t);
      s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
  });

const perfIdle = (page) =>
  page.evaluate(() => {
    const s = window.__se13;
    const now = performance.now();
    const lastEnd = s.tasks.reduce((m, t) => Math.max(m, t.start + t.dur), s.start);
    return { elapsed: now - s.start, sinceLastTask: now - lastEnd, tasks: s.tasks.length };
  });

const perfStop = (page) =>
  page.evaluate(() => {
    const s = window.__se13;
    cancelAnimationFrame(s.raf);
    s.ob?.disconnect();
    const tasks = s.tasks;
    let maxGap = 0;
    for (let i = 1; i < s.frames.length; i++) maxGap = Math.max(maxGap, s.frames[i] - s.frames[i - 1]);
    const lastEnd = tasks.reduce((m, t) => Math.max(m, t.start + t.dur), s.start);
    return {
      观察毫秒: Math.round(performance.now() - s.start),
      长任务个数: tasks.length,
      长任务合计毫秒: Math.round(tasks.reduce((a, t) => a + t.dur, 0)),
      最长长任务毫秒: Math.round(tasks.reduce((m, t) => Math.max(m, t.dur), 0)),
      最大帧间隔毫秒: Math.round(maxGap),
      最后一个长任务结束于毫秒: tasks.length ? Math.round(lastEnd - s.start) : 0,
      页面可见: document.visibilityState,
    };
  });

/** 等到界面静下来（至少观察 1.5 秒，且最后一个长任务结束已超过 1.5 秒）再收表。 */
const perfStopWhenIdle = async (page, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await perfIdle(page);
    if (s.elapsed > 1500 && s.sinceLastTask > 1500) break;
    await page.waitForTimeout(250);
  }
  return perfStop(page);
};

/** SE-13 的通过线：长任务合计与单次、帧间隔都在这条线以内才算「不卡」。 */
const assertNotJanky = (measured, what) => {
  if (measured.长任务合计毫秒 > 1000 || measured.最长长任务毫秒 > 500) {
    throw new Error(`${what}卡了：${JSON.stringify(measured)}`);
  }
};

// ── 工具标签（评审修复轮 R2 · 用户裁决 8：把标签放进容器内，标签的格式可以直接搜）──
/**
 * 量消息区里带工具标签的用户消息（在页面里执行，必须自给自足）。用户消息里的标签有两种形态：
 * - 内联：正文里就有 @[名] 字样，标签是正文里的 span[data-tool-pill]（看得见的那部分是它里面绝对定位的子节点）；
 * - 尾随：正文里没有字样，标签组（span.inline-flex.flex-wrap）跟在正文 span.whitespace-pre-wrap.break-all 之后，
 *   组里每个标签是 span[title="<工具 id>"]，页面文字是 @[显示名]（首尾的 @[ 和 ] 不占宽度）。
 * 每个标签 / 标签组量三样，都是量真实矩形，不看 DOM 在不在：
 * - 在容器内：是正文容器（div.overflow-hidden）的后代，且矩形落在容器矩形之内；
 * - 同一行：和它旁边那一行正文有纵向重叠（尾随组只看正文最后一行：正文最后一行的底 > 标签组顶 + 2）；
 * - 尾随组另记「本可放在最后一行」：正文最后一行右边还空得下这个组——空得下却掉了下去才是缺陷，
 *   最后一行本来就放不下的自然换行不算。
 * 另外把当前登记的搜索高亮范围逐个读出来（文字、矩形、是不是落在某个标签上）。
 * StaticRange 自己不能量位置——按它的起止点临时建一个 Range 来量。
 */
const measureToolTags = () => {
  const main = document.querySelector('[data-turn-scope="main"]');
  const round = (r) => ({ top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) });
  const lineRects = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return [...range.getClientRects()];
  };
  const within = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
  /**
   * 高亮范围落在标签上：高亮与标签矩形的交集占高亮的一半以上。不能要求高亮整个在标签矩形里——
   * 文字的行盒比标签的边框盒上下各高出约 1 像素；显示名被截断的标签（超出最大宽度以省略号收尾），
   * 文字范围伸出标签右边，看得见的那部分仍在标签里（首跑实跑踩到：两种形态各中一种）。
   */
  const mostlyOn = (inner, outer) => {
    const w = Math.min(inner.right, outer.right) - Math.max(inner.left, outer.left);
    const h = Math.min(inner.bottom, outer.bottom) - Math.max(inner.top, outer.top);
    return w > 0 && h > 0 && w * h >= inner.width * inner.height * 0.5;
  };
  const sameRow = (a, b) => a.bottom > b.top + 2 && b.bottom > a.top + 2;
  const TAGS = "[data-tool-pill], span.inline-flex.flex-wrap";
  const tags = [];
  let scanned = 0;
  for (const row of main ? main.querySelectorAll("[data-message-index][data-turn-index]") : []) {
    const body = row.querySelector("span.whitespace-pre-wrap.break-all");
    const container = body ? body.closest("div.overflow-hidden") : null;
    if (!body || !container) continue;
    scanned += 1;
    const box = container.getBoundingClientRect();
    // 正文里的文字节点（标签里面的不算），按先后
    const texts = [];
    for (const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); walker.nextNode(); ) {
      const node = walker.currentNode;
      if (!node.parentElement || node.parentElement.closest(TAGS)) continue;
      if ((node.textContent || "").trim()) texts.push(node);
    }
    const bodyText = texts.map((node) => node.textContent).join("");
    const lastBefore = (node) => {
      let last = null;
      for (const t of texts) if (t.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) last = t;
      return last;
    };
    const firstAfter = (node) => texts.find((t) => node.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) ?? null;
    const base = { 行: Number(row.getAttribute("data-message-index")), 正文文字: bodyText.slice(0, 40), 矩形: null, 容器矩形: round(box) };
    for (const pill of body.querySelectorAll("[data-tool-pill]")) {
      const visible = pill.querySelector(":scope > .absolute") ?? pill;
      const rect = visible.getBoundingClientRect();
      const prev = lastBefore(pill);
      const next = firstAfter(pill);
      const prevLine = prev ? lineRects(prev).at(-1) : null;
      const nextLine = next ? lineRects(next)[0] : null;
      tags.push({
        ...base,
        形态: "内联",
        文字: (visible.textContent || "").trim(),
        在容器内: container.contains(pill),
        矩形容得下: within(rect, box),
        同一行: Boolean((prevLine && sameRow(prevLine, rect)) || (nextLine && sameRow(nextLine, rect))),
        矩形: round(rect),
      });
    }
    for (const group of container.querySelectorAll("span.inline-flex.flex-wrap")) {
      const items = [...group.querySelectorAll(":scope > span[title]")];
      if (!items.length) continue;
      const rect = group.getBoundingClientRect();
      const prev = lastBefore(group);
      const prevLine = prev ? lineRects(prev).at(-1) : null;
      tags.push({
        ...base,
        形态: "尾随",
        工具: items.map((item) => ({ id: item.getAttribute("title"), 文字: (item.textContent || "").trim() })),
        文字: items.map((item) => (item.textContent || "").trim()).join(" "),
        正文含字样: /@\[/.test(bodyText),
        在容器内: container.contains(group),
        矩形容得下: within(rect, box),
        同一行: prevLine ? prevLine.bottom > rect.top + 2 : null,
        本可放在最后一行: prevLine ? prevLine.right + rect.width <= box.right + 1 : null,
        矩形: round(rect),
      });
    }
  }
  // 当前登记的搜索高亮：文字、矩形、是不是落在某个标签上
  const highlights = [];
  const layer = (name) => {
    const h = typeof CSS !== "undefined" && CSS.highlights ? CSS.highlights.get(name) : undefined;
    return h ? [...h] : [];
  };
  for (const [name, ranges] of [["jishu-search-match", layer("jishu-search-match")], ["jishu-search-current", layer("jishu-search-current")]]) {
    for (const range of ranges) {
      let rect = null;
      let text = "";
      try {
        // 高亮层里登记的是 StaticRange：自己不能量位置、也没有 toString——按它的起止点
        // 临时建一个 Range 来量矩形、读文字（首跑实跑踩到：range.toString() 得到 "[object StaticRange]"）
        const probe = document.createRange();
        probe.setStart(range.startContainer, range.startOffset);
        probe.setEnd(range.endContainer, range.endOffset);
        rect = probe.getBoundingClientRect();
        text = probe.toString();
      } catch {
        rect = null;
        text = "";
      }
      const onTag = Boolean(rect && rect.width + rect.height > 0 && tags.some((t) => mostlyOn(rect, t.矩形)));
      highlights.push({ 层: name, 文字: text, 矩形: rect ? round(rect) : null, 落在标签上: onTag });
    }
  }
  return { 量到的用户消息行: scanned, 标签: tags, 高亮: highlights };
};

/** 徽标上的命中数；这个会话行没有徽标返回 null（rowBadge 把「没有」当成 0，这里要分清）。 */
const badgeOrNull = async (row) => {
  const text = ((await row.locator("span.rounded-full").filter({ hasText: /^\s*\d+\s*$/ }).first().textContent().catch(() => "")) || "").trim();
  return /^\d+$/.test(text) ? Number(text) : null;
};

/**
 * 当前打开的会话、换一个搜索词之后「标签能不能直接搜」的事实：三处计数（侧栏徽标 / 正文高亮范围数 /
 * 标题栏计数）、每个高亮范围的文字与位置。locateRow 返回这个会话在搜索结果里的那一行（认不出返回 null）。
 */
const searchTagFacts = async (ctx, query, locateRow) => {
  const { app, page } = ctx;
  await searchAndWait(app, query);
  // 高亮登记是每帧合并一次：连续两次读数一样再记
  let last = -1;
  for (let i = 0; i < 6; i++) {
    const n = await highlightCounts(page);
    if (n === last) break;
    last = n;
    await app.sleep(300);
  }
  const measured = await page.evaluate(measureToolTags);
  const row = await locateRow().catch(() => null);
  return {
    query,
    侧栏徽标: row ? await badgeOrNull(row) : null,
    正文高亮范围数: measured.高亮.length,
    标题栏计数: await counter(page),
    高亮: measured.高亮,
    量到的标签: measured.标签.length,
    // 与高亮同一时刻量的标签矩形（报错时对照用）
    标签矩形: measured.标签.slice(0, 6).map((t) => ({ 形态: t.形态, 行: t.行, 文字: String(t.文字).slice(0, 30), 矩形: t.矩形 })),
  };
};

/** 判读一次搜索：三处计数对不对得上、高亮文字是不是搜索词、有没有高亮落在标签上。 */
const judgeTagSearch = (f) => {
  const m = /^(\d+)\/(\d+)$/.exec(String(f.标题栏计数 ?? ""));
  const total = m ? Number(m[2]) : -1;
  return {
    搜索词: f.query,
    侧栏徽标: f.侧栏徽标,
    正文高亮范围数: f.正文高亮范围数,
    标题栏计数: f.标题栏计数,
    正文与标题栏一致: f.正文高亮范围数 > 0 && f.正文高亮范围数 === total,
    三处一致: f.侧栏徽标 !== null && f.侧栏徽标 === f.正文高亮范围数 && f.正文高亮范围数 === total,
    高亮文字就是搜索词: f.高亮.length > 0 && f.高亮.every((h) => h.文字.toLowerCase() === f.query.toLowerCase()),
    落在标签上的高亮数: f.高亮.filter((h) => h.落在标签上).length,
    高亮文字: [...new Set(f.高亮.map((h) => h.文字))].slice(0, 6),
    高亮位置: f.高亮.slice(0, 6),
    标签矩形: f.标签矩形 ?? [],
  };
};

/** 「能直接搜」的断言：侧栏那一行认不出来时只告警（另两处照常核对），其余不成立直接抛错。 */
const assertTagSearch = (ctx, judged, more) => {
  const what = `搜「${judged.搜索词}」`;
  if (judged.侧栏徽标 === null) ctx.warn(`${what}时在侧栏搜索结果里认不出这个会话的行——侧栏徽标没有核对`);
  if (!judged.正文与标题栏一致) throw new Error(`${what}：正文高亮 ${judged.正文高亮范围数} 处，标题栏计数「${judged.标题栏计数}」，对不上：${JSON.stringify({ ...more, 搜索: judged })}`);
  if (!judged.三处一致) throw new Error(`${what}：侧栏徽标 ${judged.侧栏徽标}、正文高亮 ${judged.正文高亮范围数} 处、标题栏计数「${judged.标题栏计数}」，三处对不上：${JSON.stringify({ ...more, 搜索: judged })}`);
  if (!judged.高亮文字就是搜索词) throw new Error(`${what}：高亮范围的文字不是搜索词（${judged.高亮文字.join(" | ")}）：${JSON.stringify({ ...more, 搜索: judged })}`);
  if (!judged.落在标签上的高亮数) throw new Error(`${what}：有命中，但没有一处高亮落在工具标签上：${JSON.stringify({ ...more, 搜索: judged })}`);
};

/** 尾随形态没有自动化造数时跳过用的说明。 */
const NO_TRAILING_DATA =
  "尾随形态（正文没有工具字样、标签跟在正文之后）来自旧版本的剥离消息和任务启动包装，没有可靠的自动化造数——请用真实历史会话在界面上取证";

export const searchCases = [
  {
    id: "SE-1",
    name: "会话标题的字底不被裁",
    feature: "侧栏会话标题 / 需求23 补充轮",
    steps: "读侧栏每个会话标题的字体度量：字形下沿对比裁切线",
    expect: "每个标题的字形下沿都在裁切线以内",
    needs: "none",
    run: async (ctx) => {
      const { app, page } = ctx;
      await settle(ctx);
      // 刚附着上去时会话列表还没到——先等它
      if (!(await waitForSessionList(app))) ctx.skip("当前项目没有会话，量不到标题");
      const measured = await page.evaluate(measureClip, { scope: "rows" });
      if (!measured.length) ctx.skip("侧栏里没有「行高=字号 + 超出隐藏」写法的会话标题（前提不成立）");
      assertNotClipped(measured, "会话标题");
      return { 量的标题数: measured.length, 最贴近裁切线的: Math.max(...measured.map((item) => item.字底超出裁切线)), 底部余量: measured[0].底部余量, 明细: measured.slice(0, 6) };
    },
  },
  {
    id: "SE-2",
    name: "侧栏其他文字的字底不被裁",
    feature: "侧栏项目名 / 新对话 / 新任务 / 菜单入口 / 任务会话树 / 需求23 补充轮",
    steps: "读侧栏里会话标题之外、同一写法的每处文字的字体度量",
    expect: "都在裁切线以内；逐处列出量的结果",
    needs: "none",
    run: async (ctx) => {
      const { app, page } = ctx;
      await settle(ctx);
      const measured = await page.evaluate(measureClip, { scope: "others" });
      if (measured.length < 3) ctx.skip(`侧栏里只找到 ${measured.length} 处这类文字（项目名、新对话、新任务应常驻，前提不成立）`);
      assertNotClipped(measured, "侧栏文字");
      return { 量的处数: measured.length, 最贴近裁切线的: Math.max(...measured.map((item) => item.字底超出裁切线)), 明细: measured };
    },
  },
  {
    id: "SE-3",
    name: "悬停能看到完整会话标题",
    feature: "侧栏会话标题 / 需求23 补充轮",
    steps: "读每个会话标题的提示文字，和标题全文比",
    expect: "提示文字 = 标题全文（标题在页面上可能被省略号截断，但提示里是全文）",
    needs: "none",
    run: async (ctx) => {
      const { app, page } = ctx;
      await settle(ctx);
      const rows = await sessionRows(app).count();
      if (!rows) ctx.skip("当前项目没有会话");
      const titles = await page.evaluate(() =>
        [...document.querySelectorAll(".chat-sidebar button.flex-col.items-start span.truncate[title]")].map((el) => ({
          全文长度: (el.textContent || "").trim().length,
          被截断: el.scrollWidth > el.clientWidth + 1,
          提示一致: el.getAttribute("title") === (el.textContent || "").trim(),
        })),
      );
      const bad = titles.filter((item) => !item.提示一致);
      if (bad.length) throw new Error(`${bad.length} 个标题的提示文字和全文不一致`);
      return { 标题数: titles.length, 其中被省略号截断的: titles.filter((item) => item.被截断).length };
    },
  },
  {
    id: "SE-8",
    name: "会话行高度的增量在可接受范围",
    feature: "侧栏会话行 / 需求23 补充轮",
    steps: "量会话行高、标题盒子高、字号",
    expect: "标题盒子高不超过字号 + 3.5（1 像素上内边距 + 2 像素字底余量）；行高如实记录",
    needs: "none",
    run: async (ctx) => {
      const { app, page } = ctx;
      await settle(ctx);
      if (!(await sessionRows(app).count())) ctx.skip("当前项目没有会话");
      const size = await page.evaluate(() => {
        const title = document.querySelector(".chat-sidebar button.flex-col.items-start span.truncate[title]");
        const row = title?.closest("button");
        if (!title || !row) return null;
        const cs = getComputedStyle(title);
        return { 行高: Math.round(row.getBoundingClientRect().height * 10) / 10, 标题盒子高: Math.round(title.getBoundingClientRect().height * 10) / 10, 字号: parseFloat(cs.fontSize) };
      });
      if (!size) ctx.skip("没找到会话行");
      if (size.标题盒子高 > size.字号 + 3.5) throw new Error(`标题盒子高 ${size.标题盒子高} 超过字号 ${size.字号} + 3.5`);
      return size;
    },
  },
  {
    id: "SE-7",
    name: "不搜索时双击与右键没有「进入会话」的副作用",
    feature: "会话行双击 / 右键菜单 / 需求23 补充轮",
    steps: "不搜索：双击一个会话行；再右键另一个会话行看菜单",
    expect: "双击只是打开会话，搜索框保持为空；右键菜单里没有「进入会话」",
    needs: "none",
    run: async (ctx) => {
      const { app, page } = ctx;
      await settle(ctx);
      const total = await sessionRows(app).count();
      if (!total) ctx.skip("当前项目没有会话");
      await sessionRows(app).first().dblclick();
      await app.sleep(1200);
      const head = await app.sessionHeader();
      if (!head) throw new Error("双击后没有停在会话页");
      await expect(searchBox(app)).toHaveValue("");
      await sessionRows(app).nth(Math.min(1, total - 1)).click({ button: "right" });
      const menu = page.getByRole("menuitem", { name: "进入会话" });
      if (await menu.isVisible().catch(() => false)) throw new Error("不搜索时右键菜单里出现了「进入会话」");
      const hasOther = await page.getByRole("menuitem").first().isVisible().catch(() => false);
      await page.keyboard.press("Escape");
      return { 双击后停在: head.id, 菜单里有进入会话: false, 菜单正常打开: hasOther };
    },
  },
  {
    id: "SE-11",
    name: "没有命中时消息照常显示、视图不动",
    feature: "搜索态空态 / 需求23",
    steps: "打开任意一个会话 → 输入它里面没有的词",
    expect: "顶部出现「没有找到」，消息行数不变，滚动位置不变",
    needs: "none",
    run: async (ctx) => {
      const { app, page } = ctx;
      await settle(ctx);
      if (!(await sessionRows(app).count())) ctx.skip("当前项目没有会话");
      await sessionRows(app).first().click();
      await app.sleep(1500);
      const head = await app.sessionHeader();
      if (!head) throw new Error("没有停在会话页");
      await expect(messageRows(page).first()).toBeVisible({ timeout: 15000 });
      const before = await currentMatch(page);
      const rowsBefore = await messageRows(page).count();
      await searchBox(app).fill(`不存在的词${String(Date.now()).slice(-6)}`);
      // 容器高度为 0、浮条从里面溢出来显示——可见性看浮条自己
      const pill = page.locator('[data-turn-scope="main"] [data-search-empty] span');
      await expect(pill).toBeVisible({ timeout: 8000 });
      const notice = (await pill.textContent())?.trim() ?? "";
      const rowsAfter = await messageRows(page).count();
      const after = await currentMatch(page);
      if (rowsAfter !== rowsBefore) throw new Error(`消息行数变了：${rowsBefore} → ${rowsAfter}`);
      if (after.scrollTop !== before.scrollTop) throw new Error(`滚动位置变了：${before.scrollTop} → ${after.scrollTop}`);
      return { 提示: notice, 消息行数: rowsAfter, 滚动位置: after.scrollTop, 计数: await counter(page) };
    },
  },
  {
    id: "SE-9",
    name: "搜索态只显示命中消息、正文正常渲染并标黄、计数一致",
    feature: "正文区搜索态 / 侧栏徽标 / 需求23",
    steps: "不搜索打开测试会话数行数 → 搜那个独一无二的词 → 点开",
    expect: "命中行数 + 细条省略数 = 完整行数；Markdown 表格正常渲染；侧栏徽标 = 正文高亮数 = 标题栏计数；搜索结果标题字底不被裁",
    needs: "model",
    timeoutMs: 420000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await openFixtureNormally(ctx);
      await expect(messageRows(page).first()).toBeVisible({ timeout: 15000 });
      await app.sleep(800);
      const fullRows = await messageRows(page).count();
      const opened = await searchAndOpen(ctx);
      const lensRows = await messageRows(page).count();
      const gaps = await page.evaluate(() => [...document.querySelectorAll('[data-turn-scope="main"] [data-search-gap]')].map((bar) => Number(bar.getAttribute("data-search-gap"))));
      if (lensRows + gaps.reduce((a, b) => a + b, 0) !== fullRows) {
        throw new Error(`命中行数 + 细条省略数 ≠ 完整行数：${lensRows} + ${gaps.reduce((a, b) => a + b, 0)} ≠ ${fullRows}`);
      }
      const tables = await page.locator('[data-turn-scope="main"] table').count();
      const text = (await page.locator('[data-turn-scope="main"]').textContent()) ?? "";
      if (!tables) throw new Error("命中的回复里有 Markdown 表格，但页面上没有渲染出表格");
      if (/\|\s*-{3,}/.test(text)) throw new Error("正文里露出了 Markdown 表格源码");
      if (!opened.counter) throw new Error("读不到命中计数（搜索框右侧的浮层）");
      const highlights = await highlightCounts(page);
      const total = Number(opened.counter.split("/")[1]);
      if (!(highlights === total && opened.badge === total)) {
        throw new Error(`计数不一致：侧栏徽标 ${opened.badge}，正文高亮 ${highlights}，计数 ${opened.counter}`);
      }
      const clip = await page.evaluate(measureClip, { scope: "rows" });
      assertNotClipped(clip, "搜索结果标题");
      await ctx.shot("SE9-搜索态");
      await searchBox(app).fill("");
      return { 完整行数: fullRows, 命中行数: lensRows, 细条省略: gaps, 表格数: tables, 计数: opened.counter, 侧栏徽标: opened.badge, 正文高亮: highlights, 当前命中在视口内: opened.match?.inView ?? null };
    },
  },
  {
    id: "SE-10",
    name: "从别的会话点搜索结果，视图落到命中处",
    feature: "搜索态打开会话 / 需求23",
    steps: "停在另一个会话 → 搜那个词 → 点测试会话的结果",
    expect: "落点是测试会话；当前命中在视口里；标题栏计数 1/N 且等于侧栏徽标",
    needs: "model",
    timeoutMs: 420000,
    run: async (ctx) => {
      const { app, page } = ctx;
      const fixture = await ensureFixture(ctx);
      await searchBox(app).fill("");
      await app.sleep(800);
      // 先停到另一个会话（不是测试会话）；项目里只有测试会话时，先停到新对话页
      const total = await sessionRows(app).count();
      let other = null;
      for (let i = 1; i < Math.min(total, 4); i++) {
        await sessionRows(app).nth(i).click();
        await app.sleep(1500);
        const text = (await page.locator('[data-turn-scope="main"]').textContent().catch(() => "")) ?? "";
        if (text.includes(fixture.token)) continue;
        other = await app.sessionHeader();
        if (!other) continue;
        break;
      }
      if (!other) await app.newConversation();
      const opened = await searchAndOpen(ctx);
      if (!(opened.match?.内容高 > opened.match?.视口高)) {
        ctx.skip(`测试会话的命中行加起来（${opened.match?.内容高}）不比视口（${opened.match?.视口高}）高，「钉在底部」与「落在命中处」看不出区别`);
      }
      if (!opened.match?.inView) throw new Error(`当前命中不在视口里：${JSON.stringify(opened.match)}`);
      if (opened.match?.atBottom) throw new Error(`视图钉在底部：${JSON.stringify(opened.match)}`);
      if (!opened.counter) throw new Error("读不到命中计数（搜索框右侧的浮层）");
      const current = Number(opened.counter.split("/")[0]);
      if (current !== 1) throw new Error(`计数不是从 1 起：${opened.counter}`);
      if (opened.badge !== Number(opened.counter.split("/")[1])) throw new Error(`侧栏徽标 ${opened.badge} ≠ 计数 ${opened.counter}`);
      await ctx.shot("SE10-落到命中处");
      await searchBox(app).fill("");
      return { 之前停在: other?.id ?? "新对话页", 计数: opened.counter, 侧栏徽标: opened.badge, 当前命中: opened.match };
    },
  },
  {
    id: "SE-12",
    name: "刚聊完的内容侧栏搜得到、徽标数对",
    feature: "侧栏搜索 / 会话列表 / 需求23",
    steps: "不搜索打开测试会话 → 再发一条带一个新词的消息，等回复结束 → 搜这个新词 → 点开",
    expect: "结果里有这个会话（侧栏搜索的数据跟着刚聊完的内容走）；侧栏徽标数 = 正文黄底数 = 计数",
    needs: "model",
    timeoutMs: 420000,
    run: async (ctx) => {
      const fixture = await ensureFixture(ctx);
      const { app, page } = ctx;
      await openFixtureNormally(ctx);
      const token = `信标${fixture.nonce}`;
      await app.send(`第四个问题：请记住「${token}」这个词，后面会用到。这一条只回复两个字：记下。`);
      const started = await app.awaitTurnStart(20000);
      if (!started) ctx.skip("模型不可用：消息发出后 20 秒内回合未启动");
      const turn = await app.waitTurn({ budgetMs: 180000, settleMs: 4000 });
      if (!turn.done) throw new Error("这一条消息的回合没有在时限内结束");
      const idle = await app.waitIdle(3000, 120000);
      if (!idle.idle) throw new Error("回合结束后没有进入空闲");
      await searchAndWait(app, token);
      // 修前：列表里这个会话的消息停在更早的一轮，搜不到刚聊的这一条——这一行等不到
      const row = fixtureRow(ctx, token);
      await expect(row).toBeVisible({ timeout: 8000 });
      const badge = await rowBadge(row);
      await row.click();
      await app.sleep(1500);
      const head = await app.sessionHeader();
      if (head?.id !== fixture.shortId) throw new Error("点搜索结果后落点不对：不是测试会话");
      const label = await counter(page);
      if (!label) throw new Error("读不到命中计数（搜索框右侧的浮层）");
      const highlights = await highlightCounts(page);
      if (!(badge >= 1 && highlights === badge && label === `1/${badge}`)) {
        throw new Error(`计数不一致：侧栏徽标 ${badge}，正文高亮 ${highlights}，计数 ${label}`);
      }
      await ctx.shot("SE12-刚聊完的内容搜得到");
      await searchBox(app).fill("");
      return { 新词: token, 侧栏徽标: badge, 正文高亮: highlights, 计数: label };
    },
  },
  {
    id: "SE-4",
    name: "双击搜索结果进入会话并退出搜索",
    feature: "会话行双击 / 需求23 补充轮",
    steps: "记下侧栏会话总数 → 搜那个词 → 双击测试会话的结果",
    expect: "搜索框清空；侧栏恢复全部会话；测试会话显示全部消息（没有细条）",
    needs: "model",
    timeoutMs: 420000,
    run: async (ctx) => {
      const { app } = ctx;
      const fixture = await ensureFixture(ctx);
      await searchBox(app).fill("");
      await app.sleep(800);
      const sidebarRows = await sessionRows(app).count();
      await searchBox(app).fill(fixture.token);
      await expect(fixtureRow(ctx)).toBeVisible({ timeout: 8000 });
      // 侧栏过滤是延迟生效的——等列表稳定再数
      await app.sleep(1000);
      const inSearch = await sessionRows(app).count();
      await fixtureRow(ctx).dblclick();
      const facts = await enteredFacts(ctx, sidebarRows);
      return { 搜索时侧栏行数: inSearch, 进入前侧栏总数: sidebarRows, ...facts };
    },
  },
  {
    id: "SE-5",
    name: "右键「进入会话」退出搜索并打开该会话",
    feature: "会话行右键菜单 / 需求23 补充轮",
    steps: "搜那个词 → 右键测试会话的结果 → 点「进入会话」",
    expect: "菜单里有「进入会话」；点击后搜索框清空、侧栏恢复、落点是测试会话",
    needs: "model",
    timeoutMs: 420000,
    run: async (ctx) => {
      const { app, page } = ctx;
      const fixture = await ensureFixture(ctx);
      await searchBox(app).fill("");
      await app.sleep(800);
      const sidebarRows = await sessionRows(app).count();
      await searchBox(app).fill(fixture.token);
      await expect(fixtureRow(ctx)).toBeVisible({ timeout: 8000 });
      await fixtureRow(ctx).click({ button: "right" });
      const item = page.getByRole("menuitem", { name: "进入会话" });
      await expect(item).toBeVisible({ timeout: 5000 });
      await ctx.shot("SE5-右键菜单");
      await item.click();
      const facts = await enteredFacts(ctx, sidebarRows);
      await ctx.shot("SE5-进入会话后");
      return facts;
    },
  },
  {
    id: "SE-6",
    name: "进入会话后停在刚才看的那处命中",
    feature: "搜索态退出 / 需求23 + 补充轮",
    steps: "搜那个词 → 点开测试会话 → 点两次「下一处匹配」→ 记下视口顶上那行 → 双击结果行进入会话",
    expect: "那行还离视口顶一样远（±2 像素）；搜索框清空；没有细条",
    needs: "model",
    timeoutMs: 420000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await ensureFixture(ctx);
      await searchBox(app).fill("");
      await app.sleep(800);
      const sidebarRows = await sessionRows(app).count();
      const opened = await searchAndOpen(ctx);
      if (!opened.counter) throw new Error("读不到命中计数（搜索框右侧的浮层）");
      const total = Number(opened.counter.split("/")[1]);
      if (!(total >= 2)) ctx.skip(`测试会话里只有 ${total} 处命中，翻不到第二处`);
      const moves = Math.min(2, total - 1);
      for (let i = 0; i < moves; i++) {
        await app.clickTitle("下一处匹配");
        await app.sleep(900);
      }
      const before = await topRow(page);
      if (!before) throw new Error("读不到视口顶上那行");
      // 视图没滚过的话，「展开后还在原处」怎么测都过——量不到，标跳过
      if (before.row === 0 && before.offset >= 0) ctx.skip(`翻到第 ${moves + 1} 处后视图没滚动（测试会话不够高），量不到「停在原处」`);
      await fixtureRow(ctx).dblclick();
      await expect(searchBox(app)).toHaveValue("", { timeout: 5000 });
      await expect(gapBars(page)).toHaveCount(0, { timeout: 8000 });
      await app.sleep(800);
      const after = await rowOffset(page, before.row);
      if (after === null) throw new Error(`展开后找不到刚才看的那行（第 ${before.row} 行）`);
      if (Math.abs(after - before.offset) > 2) throw new Error(`刚才看的那行挪了：离视口顶 ${before.offset} → ${after}`);
      await ctx.shot("SE6-进入后停在原处");
      const rows = await sessionRows(app).count();
      if (rows !== sidebarRows) throw new Error("侧栏会话行数没有恢复");
      return { 翻了几处: moves, 刚才看的行: before.row, 离视口顶: [before.offset, after] };
    },
  },
  {
    id: "SE-13",
    name: "长会话搜一个常见字，界面不卡",
    feature: "搜索态的渲染量 / 需求23（用户原始约束：长对话必须能安全检索）",
    steps: "停到新对话（正文里没有任何会话）→ 开始记录 → 侧栏搜「的」→ 找命中最多的那个会话 → 点开它（搜索态）→ 等界面静下来 → 关键词换成「是」→ 再等静下来",
    expect: "侧栏出结果、点开长会话、换词这三步，长任务合计都不超过 1000 毫秒、单次不超过 500 毫秒；命中数、渲染行数、各项耗时如实记录",
    needs: "none",
    timeoutMs: 240000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await settle(ctx);
      await app.newConversation();
      await app.sleep(600);
      // 第一步：只输词、不点开——量侧栏自己算命中的开销
      await perfStart(page);
      await searchBox(app).fill("的");
      await app.sleep(1500);
      const typing = await perfStopWhenIdle(page, 30000);
      const rows = sessionRows(app);
      const n = await rows.count();
      let best = { index: -1, badge: 0 };
      const badges = [];
      for (let i = 0; i < Math.min(n, 40); i++) {
        const badge = await rowBadge(rows.nth(i));
        if (!Number.isFinite(badge)) continue;
        badges.push(badge);
        if (badge > best.badge) best = { index: i, badge };
      }
      badges.sort((a, b) => b - a);
      if (best.badge < 80) {
        ctx.skip(`当前项目里「的」命中最多的会话只有 ${best.badge} 处（不足 80），量不出长会话`);
      }
      // 第二步：点开命中最多的会话（搜索态只显示命中行——命中越多渲染越多）
      await perfStart(page);
      await rows.nth(best.index).click();
      await expect(messageRows(page).first()).toBeVisible({ timeout: 60000 });
      const opened = await perfStopWhenIdle(page, 60000);
      const rendered = await messageRows(page).count();
      const openedCounter = await counter(page);
      await ctx.shot("SE13-长会话搜常见字");
      // 第三步：长会话开着，换一个同样常见的词
      await perfStart(page);
      await searchBox(app).fill("是");
      await app.sleep(1500);
      const retyped = await perfStopWhenIdle(page, 60000);
      const retypedCounter = await counter(page);
      const facts = {
        命中最多的前几个会话: badges.slice(0, 5),
        点开的会话命中数: best.badge,
        搜索态渲染的消息行数: rendered,
        计数: [openedCounter, retypedCounter],
        输入时: typing,
        点开时: opened,
        换词时: retyped,
      };
      assertNotJanky(typing, "侧栏算命中时");
      assertNotJanky(opened, "点开长会话时");
      assertNotJanky(retyped, "换词时");
      return facts;
    },
  },
  {
    id: "SE-14",
    name: "工具标签（内联形态）：在正文容器内、与正文同一行、能直接搜",
    feature: "用户消息里的工具标签 / 会话内搜索（评审修复轮 R2 · 用户裁决 8：把标签放进容器内，标签的格式可以直接搜）",
    steps: "新对话：加号菜单挂一个可注入的工具（标签落在正文开头）→ 接着输入一段带编号的正文 → 发送、等回合结束 → 重载页面回到这个会话 → 量这个标签：是不是正文容器的后代、矩形在不在容器之内、和旁边的正文是不是同一行 → 侧栏搜标签的显示名、再搜「@[显示名]」，量侧栏徽标、正文高亮范围数、标题栏计数，读每个高亮范围的文字和位置",
    expect: "标签在正文容器内、矩形容得下、和正文同一行；两种搜索词下 侧栏徽标 = 正文高亮范围数 = 标题栏计数，每个高亮范围的文字就是搜索词，且至少一处高亮落在这个标签上",
    needs: "model",
    timeoutMs: 420000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await settle(ctx);
      await app.closeGuideCards();
      if (ctx.state.modelOk === false) ctx.skip("模型不可用（本轮已判定）");
      await app.newConversation();
      ctx.state.sessionsCreated += 1;
      ctx.since = Date.now();
      const nonce = String(Date.now()).slice(-6);
      // 同 J5 的顺序：先挂工具（胶囊落在空输入框里），再接正文——消息就是「@[显示名] 工具标签验证-编号：…」
      const tool = await pickInjectableTool(ctx);
      if (!tool) ctx.skip("加号菜单里没有可挂载的工具项——造不出带工具标签的消息");
      await app.type(`工具标签验证-${nonce}：只回复两个字：收到。`, { append: true });
      await app.composer().press("Enter");
      const started = await app.awaitTurnStart(20000, { text: `工具标签验证-${nonce}：只回复两个字：收到。` });
      if (!started) {
        ctx.state.modelOk = false;
        ctx.skip("模型不可用：消息发出后 20 秒内回合未启动");
      }
      ctx.state.modelOk = true;
      // 提示词只要求回复两个字，不该出现审批卡——等回合用框架默认值（不表态）
      const turn = await app.waitTurn({ budgetMs: 180000, settleMs: 4000 });
      const idle = await app.waitIdle(3000, 120000);
      if (!turn.done || !idle.idle) throw new Error("回合没有在时限内结束");
      const truth = await ctx.truth(ctx.since);
      const raw = (truth?.rawUsers ?? []).find((u) => u.includes(`工具标签验证-${nonce}`)) ?? "";
      if (!raw.includes(`@[${tool}]`)) throw new Error(`落盘的用户消息没有保留 @[${tool}] 字样：${JSON.stringify(raw.slice(0, 80))}`);
      const head = await app.sessionHeader();
      if (!head) throw new Error("读不到会话头");
      const token = `@[${tool}]`;
      const beforeReload = await page.evaluate(measureToolTags);
      // 重载后按回放路径再量（历史消息走的就是这条路）。有别的会话的回合在跑时不重载（前端会丢对流式的跟踪），
      // 改按当前显示量、并写明没走重载这一步。
      const running = await app.invoke("chat_active_sessions").catch(() => []);
      const reloaded = !(Array.isArray(running) && running.length);
      if (reloaded) {
        await reloadIntoSession(ctx, { shortId: head.id, keyword: `工具标签验证-${nonce}` });
        await expect(messageRows(page).first()).toBeVisible({ timeout: 15000 });
      } else ctx.warn(`有 ${running.length} 个会话的回合还在进行，没有重载页面——标签是按当前显示量的，没走重载后的回放路径`);
      const measured = await page.evaluate(measureToolTags);
      const mine = measured.标签.filter((t) => t.形态 === "内联" && t.文字 === token);
      await ctx.shot("SE14-内联标签");
      if (!mine.length) {
        throw new Error(`重开会话后，这条消息里没有找到工具标签 ${token}：${JSON.stringify({ 现在的标签: measured.标签.slice(0, 6), 重载前的标签: beforeReload.标签.slice(0, 6) })}`);
      }
      const misplaced = mine.filter((t) => !t.在容器内 || !t.矩形容得下 || !t.同一行);
      if (misplaced.length) throw new Error(`工具标签不在正文容器内 / 矩形伸出容器 / 和正文不在同一行：${JSON.stringify(misplaced)}`);
      // 能直接搜：搜显示名、搜 @[显示名]
      const title = (await app.sessionHeader())?.title ?? "";
      const locateRow = async () => {
        const rows = sessionRows(app);
        // 搜索结果行的文字带着命中的那一段：这条消息的命中就在带编号的正文前面
        const byNonce = rows.filter({ hasText: `工具标签验证-${nonce}` });
        if (await byNonce.count()) return byNonce.first();
        const byTitle = rows.filter({ has: page.locator(`span.truncate[title=${JSON.stringify(title)}]`) });
        return (await byTitle.count()) === 1 ? byTitle.first() : null;
      };
      const byName = judgeTagSearch(await searchTagFacts(ctx, tool, locateRow));
      await ctx.shot("SE14-搜显示名");
      const byToken = judgeTagSearch(await searchTagFacts(ctx, token, locateRow));
      await searchBox(app).fill("");
      assertTagSearch(ctx, byName, { 标签: mine });
      assertTagSearch(ctx, byToken, { 标签: mine });
      return {
        挂的工具: tool,
        消息: raw.replace(/\n+/g, " ").slice(0, 60),
        重载后量的: reloaded,
        标签: mine.map((t) => ({ 在容器内: t.在容器内, 矩形容得下: t.矩形容得下, 同一行: t.同一行, 矩形: t.矩形, 容器矩形: t.容器矩形 })),
        搜显示名: byName,
        搜原始文本: byToken,
      };
    },
  },
  {
    id: "SE-15",
    name: "工具标签（尾随形态）：历史消息里跟在正文后的标签在容器内、同一行、能直接搜",
    feature: "历史消息的工具标签 / 会话搜索（评审 R2-8：历史消息工具标签掉到下一行；用户裁决 8：搜索时识别标签的原始文本）",
    steps: "侧栏搜「@[」找出项目里带工具标签的会话 → 逐个点开（最多 5 个，每步校验落点），找一条「正文里没有工具字样、标签组跟在正文之后」的用户消息 → 量每个标签组：是不是正文容器的后代、矩形在不在容器之内、和正文最后一行是不是同一行 → 搜其中一个标签的显示名、再搜「@[显示名]」，量三处计数、每个高亮范围的文字和位置",
    expect: "每个标签组都在正文容器内、矩形容得下；正文最后一行还放得下却掉到了下一行 = 不通过；两种搜索词下 侧栏徽标 = 正文高亮范围数 = 标题栏计数，高亮范围的文字就是搜索词，且至少一处高亮落在标签上；项目里没有这种消息时标跳过并写明",
    needs: "none",
    timeoutMs: 300000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await settle(ctx);
      await app.newConversation();
      const info = await app.projectInfo();
      const listed = await app.invoke("list_sessions", { agentId: await app.chatAgentId(), encodedName: info?.encoded_name }).catch(() => []);
      // 标签的原始文本是 @[显示名]：搜「@[」就把带工具标签的会话都列出来了
      await searchAndWait(app, "@[");
      const rows = sessionRows(app);
      const total = await rows.count();
      if (!total) ctx.skip(`侧栏搜「@[」没有结果：当前项目的会话里没有带工具标签的消息。${NO_TRAILING_DATA}`);
      let found = null;
      let opened = 0;
      const tried = [];
      for (let i = 0; i < Math.min(total, 5) && !found; i++) {
        const row = rows.nth(i);
        const title = (await row.locator("span.truncate[title]").first().getAttribute("title")) || "";
        await row.click();
        await app.sleep(1500);
        const head = await app.sessionHeader();
        // 落点校验：会话头的短号得是清单里这个标题的会话（标题重复时任意一个同名会话都算）
        const ids = (Array.isArray(listed) ? listed : []).filter((s) => (s.display_name ?? "").trim() === title).map((s) => s.id);
        const landed = Boolean(head?.id) && (ids.length ? ids.some((id) => id.startsWith(head.id)) : head.title === title);
        tried.push({ 标题: title.slice(0, 20), 落点对上: landed });
        if (!landed) continue;
        opened += 1;
        const measured = await page.evaluate(measureToolTags);
        const trailing = measured.标签.filter((t) => t.形态 === "尾随" && !t.正文含字样);
        if (trailing.length) found = { head, trailing };
      }
      if (!found || !found.head) {
        ctx.skip(`点开了 ${opened} 个带工具标签的会话，都没有「正文没有工具字样、标签跟在正文之后」的消息（只有内联形态，或正文本来就带字样）。${NO_TRAILING_DATA}：${JSON.stringify(tried)}`);
      }
      await ctx.shot("SE15-尾随标签");
      const groups = found.trailing;
      const outside = groups.filter((t) => !t.在容器内 || !t.矩形容得下);
      if (outside.length) throw new Error(`历史消息的工具标签不在正文容器内 / 矩形伸出容器：${JSON.stringify(outside)}`);
      const dropped = groups.filter((t) => t.本可放在最后一行 && t.同一行 === false);
      if (dropped.length) throw new Error(`历史消息的工具标签掉到了下一行（正文最后一行还放得下）：${JSON.stringify(dropped)}`);
      if (!groups.some((t) => t.同一行 === true)) ctx.warn("这些标签组都跟着正文自然换行了（最后一行本来就放不下），「和正文最后一行同一行」这一条没有量到");
      // 能直接搜：正文里没有这个字样，搜得到才是「识别了标签的原始文本」
      const token = groups[0].工具[0].文字;
      const name = token.replace(/^@\[/, "").replace(/\]$/, "");
      const title = found.head.title;
      const locateRow = async () => {
        const byTitle = sessionRows(app).filter({ has: page.locator(`span.truncate[title=${JSON.stringify(title)}]`) });
        return (await byTitle.count()) === 1 ? byTitle.first() : null; // 同名会话不止一个就认不出是哪一行
      };
      const byName = judgeTagSearch(await searchTagFacts(ctx, name, locateRow));
      const byToken = judgeTagSearch(await searchTagFacts(ctx, token, locateRow));
      await ctx.shot("SE15-搜原始文本");
      await searchBox(app).fill("");
      assertTagSearch(ctx, byName, { 标签组数: groups.length });
      assertTagSearch(ctx, byToken, { 标签组数: groups.length });
      return {
        会话: title.slice(0, 24),
        试过的会话: tried,
        标签组: groups.map((g) => ({ 工具: g.工具.map((t) => t.文字), 正文: g.正文文字, 在容器内: g.在容器内, 矩形容得下: g.矩形容得下, 同一行: g.同一行, 本可放在最后一行: g.本可放在最后一行 })),
        搜显示名: byName,
        搜原始文本: byToken,
      };
    },
  },
].map(withCleanup);
