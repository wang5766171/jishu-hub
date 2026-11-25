/**
 * 积木：v0.9.8 需求23 搜索体验优化 + 补充轮（SE-1~SE-11）。
 * 对应需求文档 docs/v0.9.8/需求23-搜索体验优化/（02 实施与验证、03 补充轮、tests/06 测试清单）。
 *
 * 两类积木：
 * - 不需要模型（SE-1~SE-3、SE-7、SE-8、SE-11）：在当前项目已有的会话上量，项目里没有会话就跳过。
 * - 需要模型（SE-4~SE-6、SE-9、SE-10、SE-12）：首次用到时新建一个测试会话，连发三条消息——第 1、3 条
 *   带同一个独一无二的词（「蓝鲸 + 6 位编号」），第 2 条不带；第 3 条让模型回一个 Markdown 表格，
 *   表格最后一行也带这个词。搜这个词只会命中这个测试会话。测试会话留在项目里不删。SE-12 再往
 *   这个会话里发一条带另一个新词的消息——验证侧栏搜索的数据跟着刚聊完的内容走。
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

const searchBox = (app) => app.sidebar().locator("input").first();
const stopBtn = (page) => page.locator('button[title="停止"]:not([disabled])').first();
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
    const started = await stopBtn(page).waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false);
    if (!started) {
      ctx.state.modelOk = false;
      ctx.skip(`模型不可用：第 ${i + 1} 条消息发出后 20 秒内回合未启动`);
    }
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
      const started = await stopBtn(page).waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false);
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
].map(withCleanup);
