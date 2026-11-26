/**
 * 积木：v0.9.8 评审修复轮 R1（十条修复的界面层验证）。
 * 对应评审 R1-0~R1-8 与需求21。单测覆盖不到的「用户看得见的效果」在这里验证；
 * 无法稳定自动化构造的时序（如工具失败后重跑、迟到的中止回执）由单测锁定，
 * 本文件只验证能稳定走到的用户路径，并在结果里如实写明覆盖到了哪一步。
 *
 * 与其他积木文件不同的三点：
 * - F7 会点「停用并安装」——仅此一块（用户 2026-11-24 裁决的验证方式：真装冲突扩展并选
 *   「停用并安装」，验完自动恢复）。其他场景包仍然一律取消冲突卡。
 * - F6 在套装件都已装的环境里，会临时卸掉一个「本地件」（装/卸只是写/删一个清单文件，
 *   不联网）来造出可装项，用例结束时装回。
 * - 还原类积木两块（无论前面成败都会执行）：FX1 还原冲突停用与扩展，FX2 把精选件调回原状。
 *   评审修复轮 R2：台账为空时它们不再直接跳过，而是拿当前实测与运行前的基线比
 *   （安装用例超时之后才装上的扩展、F6 中途失败时没记全的精选件，都靠这一步兜住）。
 */
import { expect } from "../lib-pw.mjs";

// 长任务要足够长：数到 600 在模型快时十来秒就结束，后面还要在回合内做停止/暂存等动作
const LONG_TASK = "请从 1 数到 1500，每个数字单独一行，其他什么都不要说。";
const stopBtn = (page) => page.locator('button[title="停止"]:not([disabled])').first();
const guideCards = (app) => app.page.locator("[data-install-guide]");
const pkgDirOf = (source) => {
  const rest = String(source).replace(/^npm:/, "");
  const at = rest.lastIndexOf("@");
  return at > 0 ? rest.slice(0, at) : rest;
};

async function begin(ctx) {
  await ctx.app.ensureWorkspace();
  await ctx.app.closeGuideCards();
  await ctx.app.newConversation();
  ctx.state.sessionsCreated += 1;
  ctx.since = Date.now();
}

async function finishTurn(ctx, budget = 240000) {
  // approvals 用框架默认值（不表态）：本文件的提示词里只有 F1、F4（挂着工具问问题）可能让模型调工具——
  // 挂的是哪个工具运行时才知道，框架不替用户放行；审批档下真弹了卡，用例失败并写明，断言本身不依赖工具执行
  const turn = await ctx.app.waitTurn({ budgetMs: budget });
  const idle = await ctx.app.waitIdle(4000, budget);
  if (!turn.done || !idle.idle) throw new Error("回合未在时限内结束");
  return turn;
}

/** 加号菜单里选一个**有说明块可注入**的工具（cli/skill/mcp），返回其显示名。 */
export async function pickInjectableTool(ctx) {
  const { app } = ctx;
  const BAD = /^(附件|Skill|MCP|扩展|插件工具|输入素材|能力挂载)$/;
  await app.clickTitle("添加上下文");
  const menu = app.plusMenu();
  await expect(menu.getByText("能力挂载", { exact: true })).toBeVisible();
  const wanted = new Set(
    (await app.invoke("session_tool_list", { sessionId: "__new_session__" }))
      .filter((t) => t.injectable && t.category !== "extension")
      .map((t) => t.display_name),
  );
  const pickFrom = async () => {
    for (const btn of await menu.getByRole("button").all()) {
      const t = (await btn.textContent()).trim();
      if (t && !BAD.test(t) && wanted.has(t)) {
        await btn.click();
        return t;
      }
    }
    return null;
  };
  let picked = await pickFrom();
  if (!picked) {
    // 平铺项里没有：进 Skill 子菜单再找一遍
    const sub = menu.getByRole("button", { name: "Skill", exact: true });
    if (await sub.isVisible().catch(() => false)) {
      await sub.click();
      picked = await pickFrom();
    }
  }
  await app.dismiss();
  return picked;
}

/**
 * 页面重载后回到指定会话：用侧栏搜索缩到该会话的行（全文搜索；会话标题可能已被
 * 自动改写，不能按标题找），逐行点开并校验会话头短 id。搜索词取消息正文片段。
 */
export async function reloadIntoSession(ctx, { shortId, keyword }) {
  const { app, page } = ctx;
  await page.reload({ waitUntil: "domcontentloaded" });
  const back = page.getByRole("button", { name: "返回工作区", exact: true });
  await expect(app.composer().or(back).first()).toBeVisible({ timeout: 30000 });
  if (await back.isVisible().catch(() => false)) await back.click();
  await expect(app.composer()).toBeVisible({ timeout: 15000 });
  const box = app.sidebar().locator("input").first();
  await box.fill(keyword);
  const rows = app.sidebar().locator("button.flex-col.items-start");
  // 先等搜索把列表过滤完（防抖 + 异步）再动手：没过滤完时列表前几行是「任务会话」分组，
  // 点到会打开任务面板——面板开着时输入框被禁用，后面几个用例一开场就点不动。
  let last = -1;
  let stableRounds = 0;
  for (let i = 0; i < 40 && stableRounds < 2; i++) {
    await app.sleep(400);
    const n = await rows.count();
    if (n === last) stableRounds += 1;
    else {
      stableRounds = 0;
      last = n;
    }
  }
  const names = (await rows.allTextContents()).map((s) => s.trim());
  if (!names.length) throw new Error(`重载后搜索「${keyword}」没有找到会话`);
  // 只在过滤结果里点：会话行文本 = 标题 + 时间，标题不含正文关键词时越短越可能是目标
  const order = names.map((_, i) => i).sort((a, b) => names[a].length - names[b].length).slice(0, 5);
  let head = null;
  for (const i of order) {
    await rows.nth(i).click();
    await app.sleep(500);
    head = await app.sessionHeader();
    if (head && head.id === shortId) break;
  }
  await box.fill("");
  if (!head || head.id !== shortId) throw new Error(`重载后未能回到会话 ${shortId}（会话头：${JSON.stringify(head)}；候选：${JSON.stringify(names.slice(0, 5))}）`);
}

/** 卸载本场景包装上的扩展（已装源差集），核对回到基线。返回逐项结果。 */
async function restoreExtensions(ctx) {
  const { app } = ctx;
  const results = [];
  for (const source of [...new Set(ctx.state.installed)]) {
    const sources = await app.invoke("pi_package_installed_sources");
    if (!sources.includes(source)) {
      results.push({ source, 结果: "已不在已装源" });
      continue;
    }
    await app.invoke("pi_package_uninstall_online", { source });
    let gone = false;
    for (let i = 0; i < 40; i++) {
      await app.sleep(500);
      if (!(await app.invoke("pi_package_installed_sources")).includes(source)) {
        gone = true;
        break;
      }
    }
    results.push({ source, 已移除: gone });
  }
  ctx.state.installed = [];
  if (results.some((r) => r.已移除 === false)) throw new Error("扩展未能卸载: " + JSON.stringify(results));
  return results;
}

/** 把本场景包动过的精选件调回目标安装态（curatedTarget: id → "installed" | "uninstalled"）。 */
async function restoreCurated(ctx) {
  const { app } = ctx;
  const results = [];
  for (const [id, target] of Object.entries(ctx.state.curatedTarget)) {
    const isInstalled = async () => (await app.invoke("plugin_list")).plugins.some((p) => p.id === id);
    if ((await isInstalled()) === (target === "installed")) {
      delete ctx.state.curatedTarget[id];
      continue;
    }
    await app.invoke(target === "installed" ? "market_install" : "market_uninstall", { pluginId: id });
    const ok = (await isInstalled()) === (target === "installed");
    if (ok) delete ctx.state.curatedTarget[id];
    results.push({ id, 目标: target, 已到位: ok });
  }
  if (Object.keys(ctx.state.curatedTarget).length) throw new Error("精选件未能调回原状: " + JSON.stringify(results));
  return results;
}

/**
 * 实测的「已装本地精选件」与运行前基线的差（基线是 run.mjs 在运行开始时取的快照）。
 * 只管本地件（装卸只是写/删一个清单文件，可逆、不联网）；需要联网的件不在基线里。
 * 返回 { installed: 多装的, missing: 少装的 }；读不到实测清单返回 null。
 */
async function curatedDiff(ctx) {
  const { app } = ctx;
  const base = ctx.state.curatedBaseline;
  const [curated, plugins] = await Promise.all([app.invoke("market_list_curated").catch(() => null), app.invoke("plugin_list").catch(() => null)]);
  if (!Array.isArray(base) || !Array.isArray(curated) || !plugins) return null;
  const localIds = new Set(curated.filter((e) => e?.kind === "agent").map((e) => e.id));
  const now = (plugins.plugins || []).map((p) => p.id).filter((id) => localIds.has(id));
  return { installed: now.filter((id) => !base.includes(id)), missing: base.filter((id) => !now.includes(id)) };
}

export const fixRoundViewCases = [
  {
    id: "F5",
    name: "市场推荐卡文案正常（不露占位符）",
    feature: "插件市场精选页推荐区 / 项目特征推荐",
    steps: "进精选页 → 等项目特征推荐卡出现 → 读卡片 → 点开读弹层描述 → 关闭",
    expect: "卡片与弹层描述里是实际的项目特征文字：不含 {basis}；弹层描述是「根据项目特征：…」，不套「根据最近任务」",
    needs: "none",
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.openMarket("精选");
      const card = page.locator('[data-bundle-card="dynamic"]');
      if (!(await card.first().waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false))) {
        // 推荐卡只在「最近活跃项目是代码目录 + 该场景有 ≥2 个可推荐件未装」时出现——如实记录是哪个条件不满足
        const last = await app.invoke("load_last_project").catch(() => null);
        const scene = last ? await app.invoke("workspace_scene", { projectPath: last }).catch(() => null) : null;
        ctx.skip(
          `当前环境没有项目特征推荐卡（最近项目${last ? "有" : "无"}记录、项目特征${scene ? `判定为「${scene.scene}」` : "无定论"}；或该场景可推荐件不足 2 个未装）`,
        );
      }
      const cardText = (await card.first().textContent()).replace(/\s+/g, " ").trim();
      await ctx.shot("F5-推荐卡");
      await card.first().click();
      const dialog = page.locator("[data-bundle-dialog]");
      await expect(dialog).toBeVisible();
      const dialogText = (await dialog.textContent()).replace(/\s+/g, " ").trim();
      await ctx.shot("F5-推荐弹层");
      await app.click("Close", { scope: dialog });
      if (cardText.includes("{basis}") || dialogText.includes("{basis}")) throw new Error("文案仍露占位符 {basis}");
      if (!cardText.includes("项目特征：")) throw new Error("推荐卡应为项目特征整句: " + cardText.slice(0, 80));
      if (!/根据项目特征：/.test(dialogText) || /根据最近任务/.test(dialogText)) {
        throw new Error("弹层描述句式不符: " + dialogText.slice(0, 120));
      }
      return { 卡片: cardText.slice(0, 80), 弹层描述: dialogText.slice(0, 80) };
    },
  },
];

/** 页面类（会重载页面，必须排在全部对话用例之后）：套装弹层。 */
export const fixRoundReloadCases = [
  {
    id: "F6",
    name: "套装装完关掉再开另一个：有安装入口，不停在上次汇总",
    feature: "套装详情弹层（需求5）/ 评审 R1-7 运行结果属于弹层的一次打开",
    steps: "精选页 → 打开一个有「未装的本地件」的套装（都已装时临时卸一个造出来）→ 只装这一件 → 关闭 → 打开另一个套装 → 读页脚 → 调回原状",
    expect: "第二个套装的页脚是安装入口（或全部已安装），不显示上一次的「安装完成」汇总和「重试失败项」",
    needs: "none",
    timeoutMs: 180000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.openMarket("精选");
      const bundles = await app.invoke("market_list_bundles");
      const curated = await app.invoke("market_list_curated");
      const kindOf = Object.fromEntries(curated.map((e) => [e.id, e.kind]));
      const titleOf = Object.fromEntries(curated.map((e) => [e.id, e.title]));
      const isInstalled = async (id) => (await app.invoke("plugin_list")).plugins.some((p) => p.id === id);
      // 本地件：装/卸只是写/删一个清单文件，不联网、可逆
      const localIdsOf = (b) => b.items.map((i) => i.ref.replace(/^curated:/, "")).filter((id) => kindOf[id] === "agent");
      const target = bundles.find((b) => localIdsOf(b).length);
      if (!target) ctx.skip("套装里没有本地件（只剩需要联网的件）");
      const other = bundles.find((b) => b.id !== target.id);
      if (!other) ctx.skip("只有一个套装，无法验证「再开另一个」");

      let want = null;
      for (const id of localIdsOf(target)) {
        if (!(await isInstalled(id))) {
          want = id;
          break;
        }
      }
      let borrowed = false;
      if (!want) {
        // 套装件都已装：临时卸掉其中一个本地件造出可装项；目标态记为「装回」，还原用例兜底
        want = localIdsOf(target)[0];
        await app.invoke("market_uninstall", { pluginId: want });
        ctx.state.curatedTarget[want] = "installed";
        borrowed = true;
        // 市场页若已打开，它手里的已装清单是卸载前的——重载页面让它按最新状态渲染。
        // 重载后等界面真正落定（会话列表渲染出来）：刚重载完的几秒里界面还没就绪。
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(app.composer()).toBeVisible({ timeout: 30000 });
        await expect(app.sidebar().locator("button.flex-col.items-start").first()).toBeVisible({ timeout: 30000 });
        await app.sleep(2000);
      } else {
        ctx.state.curatedTarget[want] = "uninstalled"; // 本来就没装：用例结束要卸掉
      }
      try {
      await app.openMarket("精选");
      const cardA = page.locator(`[data-bundle-card="${target.scene}"]`);
      await expect(cardA.first()).toBeVisible({ timeout: 15000 });
      await cardA.first().click();
      const dialog = page.locator("[data-bundle-dialog]");
      await expect(dialog).toBeVisible();
      // 只装 want 这一件。必备件（勾选锁定）里未装的只能是 want——否则点安装会代装别的必备件。
      const lockedLabels = await dialog.locator("label:has(input[type=checkbox][disabled]:checked)").allTextContents();
      const foreign = lockedLabels.filter((t) => !/已安装/.test(t) && !t.includes(titleOf[want]));
      if (foreign.length) {
        await app.click("Close", { scope: dialog });
        ctx.skip(`套装里有未装的必备件（${foreign.map((t) => t.replace(/\s+/g, " ").trim().slice(0, 20)).join("、")}，勾选锁定），本用例不代装`);
      }
      for (const box of await dialog.locator("input[type=checkbox]:not([disabled])").all()) {
        if (await box.isChecked()) await box.click();
      }
      const wantBox = dialog.locator("label", { hasText: titleOf[want] }).first().locator("input[type=checkbox]");
      if (!(await wantBox.isChecked()) && !(await wantBox.isDisabled())) {
        await dialog.locator("label", { hasText: titleOf[want] }).first().click();
      }
      const install = dialog.getByRole("button", { name: /安装选中项/ });
      await expect(install).toBeEnabled();
      await install.click();
      // 恰好装 1 件 = 只装了 want（没有代装别的）
      await expect(dialog).toContainText(/成功 1 项/, { timeout: 60000 });
      const firstRun = (await dialog.textContent()).replace(/\s+/g, " ").trim();
      await ctx.shot("F6-第一个套装装完");
      // 借出的件要实测装回了才算回到原状（评审修复轮 R2：原来只凭弹层文案「成功 1 项」销账）；
      // 没装上则留在目标态表里，由还原用例 FX2 装回
      if (borrowed && (await isInstalled(want))) delete ctx.state.curatedTarget[want];
      await app.click("Close", { scope: dialog });
      await expect(dialog).toBeHidden();

      const cardB = page.locator(`[data-bundle-card="${other.scene}"]`);
      await cardB.first().click();
      await expect(dialog).toBeVisible();
      const buttons = (await dialog.getByRole("button").allTextContents()).map((t) => t.trim());
      const text = (await dialog.textContent()).replace(/\s+/g, " ");
      await ctx.shot("F6-再开另一个套装");
      await app.click("Close", { scope: dialog });
      await restoreCurated(ctx);
      const verdict = { 第一个套装装完: firstRun.slice(0, 60), 第二个套装页脚按钮: buttons.filter((t) => /安装选中项|全部已安装|重试失败项|取消剩余项/.test(t)) };
      if (text.includes("安装完成") || buttons.some((t) => t.includes("重试失败项"))) {
        throw new Error("第二个套装停在上一次的运行结果: " + JSON.stringify(verdict));
      }
      if (!buttons.some((t) => /安装选中项|全部已安装/.test(t))) {
        throw new Error("第二个套装没有安装入口: " + JSON.stringify(verdict));
      }
      return { 装过的件: want, 借出造条件: borrowed, 再打开: other.title, ...verdict };
      } finally {
        // 中途失败也不把模态弹层留给后面的用例
        const left = page.locator("[data-bundle-dialog]");
        if (await left.isVisible().catch(() => false)) await app.click("Close", { scope: left }).catch(() => {});
      }
    },
  },
];

export const fixRoundCases = [
  {
    id: "F1",
    name: "挂工具的消息重开会话不再出现「未送达」重复",
    feature: "发送防丢账（需求2 账先行）/ 评审 R1-1 账本身份化",
    steps: "新对话 → 加号菜单挂一个工具 → 补正文 → 回车 → 等回合结束 → 重载页面回到该会话 → 读消息区",
    expect: "该消息只出现一次；页面没有「未送达」徽标",
    needs: "model",
    run: async (ctx) => {
      const { app, page } = ctx;
      if (ctx.state.modelOk === false) ctx.skip("模型不可用（本轮已判定）");
      await begin(ctx);
      const tool = await pickInjectableTool(ctx);
      if (!tool) ctx.skip("加号菜单里没有可注入说明块的工具项");
      // 每轮一个唯一编号：相近时间创建的会话，会话头前 8 位会相同——只靠「短 id + 固定
      // 搜索词」可能找回上一轮的旧会话。消息带上本轮编号，重开会话时也按它搜索。
      const NONCE = `编号${String(Date.now()).slice(-6)}`;
      const MARK = `请用刚才挂载的工具回答：一加一等于几？只回答数字，不要解释。（${NONCE}）`;
      await app.type(MARK, { append: true });
      await app.composer().press("Enter");
      const started = await app.awaitTurnStart(15000, { text: MARK });
      if (!started) {
        ctx.state.modelOk = false;
        ctx.skip(`已挂载「${tool}」；模型不可用，发送段跳过`);
      }
      ctx.state.modelOk = true;
      await finishTurn(ctx);
      const head = await app.sessionHeader();
      if (!head) throw new Error("回合结束后读不到会话头");
      await reloadIntoSession(ctx, { shortId: head.id, keyword: NONCE });
      await expect(page.getByText(MARK).first()).toBeVisible({ timeout: 15000 });
      // 只数消息区：侧栏会话行的标题可能就是消息开头，整页计数会被污染
      const mainText = await page.evaluate(() => {
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll(".chat-sidebar").forEach((e) => e.remove());
        clone.querySelectorAll("textarea").forEach((e) => e.remove());
        return (clone.textContent || "").replace(/\s+/g, " ");
      });
      const occurrences = mainText.split(MARK).length - 1;
      await ctx.shot("F1-重开会话");
      if (occurrences !== 1) throw new Error(`消息区里该消息出现了 ${occurrences} 次（应为 1）`);
      if (mainText.includes("未送达")) throw new Error("消息区出现「未送达」徽标");
      return { 挂载: tool, 本轮编号: NONCE, 会话头短id: head.id, 消息出现次数: occurrences, 含未送达: false };
    },
  },
  {
    id: "F2",
    name: "新对话 id 解析前暂存的消息不丢且会投递",
    feature: "待发送区随会话 id 解析搬家（需求21）",
    steps: "新对话发长任务 → 紧接着（会话头仍是临时键时）连发两条进暂存 → 等 id 解析 → 等全部回合结束",
    expect: "id 解析后两张暂存卡片仍在；落盘真值里两条都被投递",
    needs: "model",
    timeoutMs: 480000,
    run: async (ctx) => {
      const { app, page } = ctx;
      if (ctx.state.modelOk === false) ctx.skip("模型不可用（本轮已判定）");
      // 「暂存发生在 id 解析之前」必须如实核对：引擎预热后新会话的 id 可能比暂存动作还快
      // 解析完——那样的回合虽然也通过断言，却没测到本用例。没赶上就换一个新会话再试。
      const attempts = [];
      let headerWhenStaged = "";
      let headerWhenStaged2 = "";
      for (let round = 0; round < 3; round++) {
        await begin(ctx);
        await app.type(LONG_TASK);
        await app.composer().press("Enter");
        await expect(app.composer()).toHaveValue("", { timeout: 5000 });
        // 输入框仍聚焦：直接键入并回车（= 暂存）。先读会话头——那就是暂存发生时刻的 id 状态。
        await page.keyboard.insertText("解析前暂存甲：只回复「甲」");
        headerWhenStaged = await app.headerIdText();
        await page.keyboard.press("Enter");
        const stagedFirst = await app.stagedGrips().first().waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false);
        if (!stagedFirst) {
          ctx.state.modelOk = false;
          ctx.skip("模型不可用：首条消息发出后回合未启动（第二条没有进暂存区）");
        }
        ctx.state.modelOk = true;
        attempts.push(headerWhenStaged);
        if (!/pending/.test(headerWhenStaged)) {
          // 没赶上：换一个新会话再试。先等这条长任务收场（评审修复轮 R2：原来直接换下一个，最多两个
          // 长任务留在后台继续跑、和后面的用例抢界面）——等 4 分钟还在跑就点停止结束它
          const idle = await app.waitIdle(3000, 240000).catch(() => ({ idle: false }));
          if (!idle.idle) {
            await stopBtn(page).click({ timeout: 3000 }).catch(() => {});
            await app.waitIdle(3000, 120000).catch(() => {});
          }
          continue;
        }
        await expect(app.composer()).toHaveValue("", { timeout: 5000 });
        await page.keyboard.insertText("解析前暂存乙：只回复「乙」");
        headerWhenStaged2 = await app.headerIdText();
        await page.keyboard.press("Enter");
        break;
      }
      if (!/pending/.test(headerWhenStaged)) {
        ctx.skip(`3 个新会话都没赶上 id 解析前的窗口（暂存时会话头依次：${attempts.join("、")}）`);
      }
      await expect(app.stagedGrips()).toHaveCount(2, { timeout: 8000 });
      await app.waitSessionResolved(30000);
      await app.sleep(1500); // 给「切到真实键 → 重渲染」留出时间再数卡片
      const stagedAfterResolve = await app.stagedTexts();
      await ctx.shot("F2-id解析后暂存区");
      if (stagedAfterResolve.length !== 2) {
        throw new Error(`id 解析后暂存卡片剩 ${stagedAfterResolve.length} 张（应为 2）: ${JSON.stringify(stagedAfterResolve)}`);
      }
      await finishTurn(ctx, 420000);
      const truth = await ctx.truth(ctx.since);
      const users = truth?.users ?? [];
      const delivered = ["解析前暂存甲", "解析前暂存乙"].map((k) => users.some((u) => u.includes(k)));
      if (delivered.some((ok) => !ok)) throw new Error("暂存的消息没有被投递: " + JSON.stringify(users.map((u) => u.slice(0, 16))));
      return {
        暂存时会话头: headerWhenStaged,
        暂存第二条时会话头: headerWhenStaged2,
        尝试过的会话头: attempts,
        解析后暂存数: stagedAfterResolve.length,
        落盘用户消息数: users.length,
      };
    },
  },
  {
    id: "F3",
    name: "停止后立刻重发：新消息得到完整回复、不卡「处理中」",
    feature: "回合归属（评审 R1-4）/ 停止与重发",
    steps: "新对话发长任务 → 回合启动后立刻点停止 → 立刻重发一条 → 等全部回合结束",
    expect: "重发的消息落盘、其后有一条助手回复；页面停止钮退场（不卡处理中）",
    needs: "model",
    timeoutMs: 360000,
    run: async (ctx) => {
      const { app, page } = ctx;
      if (ctx.state.modelOk === false) ctx.skip("模型不可用（本轮已判定）");
      await begin(ctx);
      await app.send(LONG_TASK);
      const started = await app.awaitTurnStart(15000);
      if (!started) {
        ctx.state.modelOk = false;
        ctx.skip("模型不可用：发送后 15 秒内回合未启动");
      }
      ctx.state.modelOk = true;
      await stopBtn(page).click();
      await app.send("停止后重发：只回复两个字「收到」，其他什么都不要说。");
      // 失败时留住现场（截图 + 界面状态 + 落盘序列）：这一步的失败模式不止一种，事后无从复现
      try {
        await finishTurn(ctx, 150000);
      } catch (e) {
        await ctx.shot("F3-失败现场");
        const scene = await page.evaluate(() => ({
          停止钮: !!document.querySelector('button[title="停止"]:not([disabled])'),
          暂存: [...document.querySelectorAll('div[class*="bg-amber-500/5"]')].map((x) => (x.querySelector("p")?.textContent || "").trim().slice(0, 20)),
          输入框: ([...document.querySelectorAll("textarea")].find((t) => t.getBoundingClientRect().height > 0)?.value ?? "").slice(0, 30),
          页面含重发消息: (document.body.textContent || "").includes("停止后重发"),
        }));
        const truth0 = await ctx.truth(ctx.since);
        throw new Error(`${e?.message || e}｜现场：${JSON.stringify(scene)}｜落盘：${JSON.stringify(truth0?.sequence ?? null)}`);
      }
      const truth = await ctx.truth(ctx.since);
      const seq = truth?.sequence ?? [];
      const at = seq.findIndex((m) => m.role === "user" && m.text.includes("停止后重发"));
      if (at < 0) throw new Error("重发的消息没有落盘: " + JSON.stringify(seq));
      const reply = seq.slice(at + 1).find((m) => m.role === "assistant" && m.text);
      if (!reply) throw new Error("重发的消息之后没有助手回复: " + JSON.stringify(seq));
      if (await stopBtn(page).isVisible().catch(() => false)) throw new Error("回合结束后停止钮仍在（卡处理中）");
      await ctx.shot("F3-重发完成");
      return { 落盘序列: seq, 重发后的回复: reply.text };
    },
  },
  {
    id: "F4",
    name: "回合结束自动发送的消息点名了工具，工具说明已注入",
    feature: "发送入口统一确定本条工具集（评审 R1-5）",
    steps: "新对话发长任务 → 等 id 解析 → 暂存一条带 @[工具名] 的消息（不点引导）→ 等回合结束自动发送",
    expect: "落盘的这条消息里带有该工具的说明块，且保留 @[工具名] 字样",
    needs: "model",
    timeoutMs: 420000,
    run: async (ctx) => {
      const { app } = ctx;
      if (ctx.state.modelOk === false) ctx.skip("模型不可用（本轮已判定）");
      const tool = (await app.invoke("session_tool_list", { sessionId: "__new_session__" })).find((t) => t.injectable && t.category !== "extension");
      if (!tool) ctx.skip("没有可注入说明块的工具");
      await begin(ctx);
      await app.send(LONG_TASK);
      const started = await stopBtn(ctx.page).waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false);
      if (!started) {
        ctx.state.modelOk = false;
        ctx.skip("模型不可用：发送后 15 秒内回合未启动");
      }
      ctx.state.modelOk = true;
      await app.waitSessionResolved(30000);
      await app.sleep(1200);
      await app.send(`自动发送点名：请用 @[${tool.display_name}]，只回复「好」。`);
      await expect(app.stagedGrips()).toHaveCount(1, { timeout: 8000 });
      await finishTurn(ctx, 360000);
      const truth = await ctx.truth(ctx.since);
      // 读落盘原文（不剥离注入块）——注入了什么以它为准
      const raw = (truth?.rawUsers ?? []).find((u) => u.includes("自动发送点名"));
      if (!raw) throw new Error("自动发送的消息没有落盘: " + JSON.stringify((truth?.users ?? []).map((u) => u.slice(0, 16))));
      if (!raw.includes("<JISHU-TOOL-PLUGINS>")) throw new Error("这条消息没有带上工具说明块（修前表现）");
      if (!raw.includes(`@[${tool.display_name}]`)) throw new Error("这条消息没有保留 @[工具名] 字样");
      return {
        点名: tool.display_name,
        落盘消息长度: raw.length,
        含说明块: true,
        说明块节选: raw.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("<") && l.length > 6)?.slice(0, 50) ?? "",
      };
    },
  },
  {
    id: "F7",
    name: "真装冲突扩展选「停用并安装」：同步后不复活、引擎健康、卸载后恢复",
    feature: "冲突治理（需求15）/ 评审 R1-0 停用落到启停闸门 / 装后引导卡文案（R1-8）",
    steps: "扩展生态页点会冲突的候选「安装」→ 冲突卡选「停用并安装」→ 触发一次插件重载（注册同步）→ 新建对话发消息 → 卸载该扩展",
    expect: "被停用的扩展不在已装源、登记簿显示停用；同步后依旧；新对话能正常得到回复；引导卡不写「pi 扩展」；卸载后被停用的扩展全部恢复",
    needs: "network",
    timeoutMs: 600000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.openMarket("扩展生态");
      const installs = page.getByRole("button", { name: "安装", exact: true });
      if (!(await installs.first().waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false))) {
        ctx.skip("扩展生态页没有可安装项（目录未加载 / 无网络 / 已全部安装）");
      }
      const baseline = await app.invoke("pi_package_installed_sources");
      const overridesBefore = await app.invoke("pi_extension_overrides_list");
      if (overridesBefore.length) ctx.skip(`环境里已有冲突停用记录（${overridesBefore.length} 条），不在其上叠加`);

      // 找到会弹「能力重叠」卡的候选（最多试 4 个，每个最多等 90 秒）
      let conflict = null;
      const tried = [];
      for (let k = 0; k < Math.min(await installs.count(), 4) && !conflict; k++) {
        const name = (await installs.nth(k).evaluate((el) => (el.parentElement?.parentElement?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30)));
        await installs.nth(k).click();
        const deadline = Date.now() + 90000;
        let outcome = "TIMEOUT";
        while (Date.now() < deadline) {
          const dlg = page.getByRole("dialog").first();
          if (await dlg.isVisible().catch(() => false)) {
            const text = (await dlg.textContent()).replace(/\s+/g, " ").slice(0, 300);
            if (/能力重叠|停用并安装/.test(text)) {
              outcome = "CONFLICT";
              conflict = { dlg, text };
              break;
            }
          }
          const cancel = page.getByRole("dialog").first().getByRole("button", { name: /^取消/ });
          if (await cancel.isVisible().catch(() => false)) {
            await cancel.click();
            outcome = "OTHER_DIALOG";
            break;
          }
          const added = (await app.invoke("pi_package_installed_sources")).filter((s) => !baseline.includes(s));
          if (added.length) {
            // 没弹冲突卡就装上了：登记后卸掉，换下一个候选
            ctx.state.installed.push(...added);
            ctx.state.installedLog.push(...added);
            outcome = "INSTALLED_NO_CONFLICT";
            break;
          }
          await app.sleep(700);
        }
        tried.push({ 候选: name, 结果: outcome });
        if (outcome === "INSTALLED_NO_CONFLICT") {
          await restoreExtensions(ctx);
          await app.openMarket("扩展生态");
        }
      }
      if (!conflict) ctx.skip("候选里没有会弹冲突卡的扩展: " + JSON.stringify(tried.map((t) => [t.候选, t.结果])));
      await ctx.shot("F7-冲突卡");

      await conflict.dlg.getByRole("button", { name: /^停用并安装/ }).click();
      // 「停用并安装」= 注册新包 → 探针检出冲突 → 逐个停用对手（先记登记簿、后摘注册）→ 终验 →
      // 弹引导卡。四个事实都成立才算装完：新包进已装源、对手全部记入登记簿（数量以冲突卡
      // 列出的为准）、被停用者全部从注册表摘除、引导卡出现。只看前一两个会在中途误判完成。
      const expectedStops = Math.max(conflict.text.split("（工具 ").length - 1, 1);
      let added = [];
      let overrides = [];
      let settled = false;
      let lastSeen = null;
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        const sources = await app.invoke("pi_package_installed_sources");
        added = sources.filter((s) => !baseline.includes(s));
        overrides = await app.invoke("pi_extension_overrides_list");
        const dirs = sources.map(pkgDirOf);
        lastSeen = {
          新装: added.length,
          停用记录: overrides.length,
          仍注册的被停用者: overrides.filter((o) => dirs.includes(pkgDirOf(o.source))).map((o) => pkgDirOf(o.source)),
          引导卡: await guideCards(app).count(),
        };
        if (
          added.length
          && overrides.length >= expectedStops
          && overrides.every((o) => !dirs.includes(pkgDirOf(o.source)))
          && lastSeen.引导卡 > 0
        ) {
          settled = true;
          break;
        }
        await app.sleep(500);
      }
      if (!settled) throw new Error("选「停用并安装」后在 4 分钟内没有完整落定，最后看到: " + JSON.stringify(lastSeen));
      ctx.state.installed.push(...added);
      ctx.state.installedLog.push(...added);
      const stoppedDirs = overrides.map((o) => pkgDirOf(o.source));

      const snapshot = async () => {
        const sources = await app.invoke("pi_package_installed_sources");
        const dirs = sources.map(pkgDirOf);
        const registry = await app.invoke("extension_registry_list");
        return {
          被停用者仍在已装源: stoppedDirs.filter((d) => dirs.includes(d)),
          停用态: Object.fromEntries(stoppedDirs.map((d) => [d, registry.find((e) => e.pkg_key === `npm:${d}`)?.state ?? "(不在簿)"])),
          替代者在位: added.every((s) => sources.includes(s)),
        };
      };
      const afterDisable = await snapshot();
      if (afterDisable.被停用者仍在已装源.length || !afterDisable.替代者在位) throw new Error("停用并安装后的状态不符: " + JSON.stringify(afterDisable));
      // 引导卡文案（R1-8）：装完时右下角的引导卡不写引擎代号。
      await guideCards(app).first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
      const guideSeen = (await guideCards(app).count()) > 0;
      if (guideSeen) await ctx.shot("F7-装后引导卡");
      const guideText = (await guideCards(app).first().textContent().catch(() => "")).replace(/\s+/g, " ");
      if (!guideSeen) throw new Error("装完后没有出现装后引导卡（无法核对 R1-8 文案）");
      await app.closeGuideCards();

      // 触发一次注册同步（插件重载 = 启动同步同一段逻辑）。修前：被停用的内置扩展在这里被补回。
      await app.invoke("plugin_reload");
      await app.sleep(2500);
      const afterSync = await snapshot();
      if (afterSync.被停用者仍在已装源.length) throw new Error("同步后被停用的扩展被补回（修前表现）: " + JSON.stringify(afterSync));

      // 引擎健康：新开一个对话（新拉起引擎进程）发消息，要能得到回复。
      await begin(ctx);
      await app.send("请只回复两个字：收到");
      const probeStarted = await app.awaitTurnStart(20000);
      if (!probeStarted) throw new Error("停用期间新对话无法启动回合（引擎可能因工具重名启动失败）");
      await finishTurn(ctx);
      const truth = await ctx.truth(ctx.since);
      const lastUser = (truth?.sequence ?? []).findLastIndex((m) => m.role === "user");
      const probeReply = (truth?.sequence ?? []).slice(lastUser + 1).find((m) => m.role === "assistant" && m.text);
      if (!probeReply) throw new Error("停用期间新对话没有得到回复: " + JSON.stringify(truth?.sequence ?? []));
      await ctx.shot("F7-停用期间对话正常");

      // 卸载替代者 → 被停用的扩展自动恢复（与还原用例同一口径核对：停用记录清空 **且** 被停用者回到注册表）。
      await restoreConflictDisables(ctx);
      const sourcesAfter = (await app.invoke("pi_package_installed_sources")).map(pkgDirOf);
      const restored = stoppedDirs.map((d) => [d, sourcesAfter.includes(d)]);
      const uninstall = added.every((s) => !sourcesAfter.includes(pkgDirOf(s)));
      if (guideSeen && /pi 扩展/i.test(guideText)) throw new Error("引导卡仍写引擎代号: " + guideText.slice(0, 80));
      return {
        尝试: tried, 新装: added, 被停用: stoppedDirs,
        停用后: afterDisable, 同步后: afterSync, 替代者已卸载: uninstall, 恢复: restored,
        引导卡出现: guideSeen, 引导卡文本: guideText.slice(0, 60), 停用期间对话回复: probeReply.text,
      };
    },
  },
];

/**
 * 等安装/卸载流程静止：已装源与停用记录连续 stableMs 不再变化。「停用并安装」的各步之间
 * 有数秒不做任何落盘的探针，所以静止窗口要给到十几秒——只看三五秒会把探针当成结束。
 */
async function waitQuiet(ctx, { stableMs = 15000, budgetMs = 120000 } = {}) {
  const { app } = ctx;
  const sig = async () =>
    JSON.stringify([await app.invoke("pi_package_installed_sources"), await app.invoke("pi_extension_overrides_list")]);
  let last = await sig();
  let since = Date.now();
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await app.sleep(700);
    const now = await sig();
    if (now !== last) {
      last = now;
      since = Date.now();
      continue;
    }
    if (Date.now() - since >= stableMs) return true;
  }
  return false;
}

/**
 * 还原冲突停用：卸载替代者（被停用的扩展随之自动恢复），核对**两件事都成立**——停用记录
 * 清空、被停用者回到注册表。
 *
 * 为什么要等静止、要重试：卸载流程自带「恢复后引擎自检失败就退回停用」的保护分支。前一用例
 * 在「停用并安装」走到一半时失败，这里若立刻卸载，两个流程会并发改同一份注册表，自检因
 * 撞名失败而触发退回——环境留在停用态。只看「停用记录为空」还会恰好读在退回之前的那一瞬
 *（2026-11-24 实录：还原用例报了成功，环境实际停在停用态）。所以：先等静止；还原后两项
 * 都核对；不成立再试，最多 3 次；仍不成立就报失败，不假报成功。
 */
async function restoreConflictDisables(ctx) {
  const { app } = ctx;
  const attempts = [];
  for (let round = 0; round < 3; round++) {
    const overrides = await app.invoke("pi_extension_overrides_list");
    if (!overrides.length && !ctx.state.installed.length) return { 已还原: true, 尝试: attempts };
    if (!(await waitQuiet(ctx))) attempts.push({ 第几次: round + 1, 注意: "等了 2 分钟流程仍未静止" });
    const stoppedDirs = overrides.map((o) => pkgDirOf(o.source));
    const sources = await app.invoke("pi_package_installed_sources");
    // 替代者还装着的：登记进待卸载清单，由统一的卸载逻辑处理
    for (const entry of overrides) {
      const replacer = sources.find((s) => pkgDirOf(s) === pkgDirOf(entry.replaced_by));
      if (replacer && !ctx.state.installed.includes(replacer)) ctx.state.installed.push(replacer);
    }
    const uninstalled = ctx.state.installed.length ? await restoreExtensions(ctx) : [];
    await waitQuiet(ctx, { stableMs: 8000, budgetMs: 40000 });
    const overridesAfter = await app.invoke("pi_extension_overrides_list");
    const dirsAfter = (await app.invoke("pi_package_installed_sources")).map(pkgDirOf);
    const restored = stoppedDirs.map((d) => [d, dirsAfter.includes(d)]);
    const ok = !overridesAfter.length && stoppedDirs.every((d) => dirsAfter.includes(d));
    attempts.push({ 第几次: round + 1, 卸载: uninstalled, 剩余停用记录: overridesAfter.length, 恢复: restored, 成立: ok });
    if (ok) return { 已还原: true, 尝试: attempts };
  }
  throw new Error("冲突停用没能还原（卸载替代者后被停用的扩展没有全部恢复）——请手动到扩展生态页核对「联网搜索」等扩展的状态: " + JSON.stringify(attempts));
}

/** 还原类：无论前面成败都执行。 */
export const fixRoundCleanupCases = [
  {
    id: "FX1",
    name: "还原：清掉冲突停用（卸载替代者即自动恢复被停用的扩展）",
    feature: "副作用还原",
    steps: "若登记簿有冲突停用记录、本场景包装的扩展还在、或当前已装源比运行前的基线多出东西：先等安装流程静止 → 卸载替代者 → 核对停用记录清空且被停用的扩展回到注册表（不成立重试，最多 3 次）；三者都没有时如实返回「已核对：已装源 = 基线」",
    expect: "已装源回到本轮开始时的清单；登记簿没有冲突停用记录；被停用的扩展全部恢复注册",
    needs: "none",
    timeoutMs: 600000,
    cleanup: true,
    run: async (ctx) => {
      const overrides = await ctx.app.invoke("pi_extension_overrides_list");
      // 评审修复轮 R2：台账为空也要核对基线——安装用例 90 秒超时之后才装上的扩展不会进台账
      const sources = await ctx.app.invoke("pi_package_installed_sources").then((v) => (Array.isArray(v) ? v : null), () => null);
      if (!sources) ctx.skip("读不到当前已装源，没法核对它和运行前的基线一致不一致");
      for (const source of sources.filter((s) => !ctx.state.baselineSources.includes(s))) {
        if (!ctx.state.installed.includes(source)) ctx.state.installed.push(source);
      }
      if (!overrides.length && !ctx.state.installed.length) {
        return { 核对: "没有需要还原的冲突停用（已核对：停用记录为空，当前已装源 = 运行前的基线）", 基线数: ctx.state.baselineSources.length };
      }
      const result = await restoreConflictDisables(ctx);
      if (!result.尝试.every((a) => a.成立)) throw new Error("冲突停用经重试才还原: " + JSON.stringify(result));
      return result;
    },
  },
  {
    id: "FX2",
    name: "还原：把本场景包动过的精选件调回原状",
    feature: "副作用还原",
    steps: "目标态表里有精选件：按目标安装/卸载；表是空的：把当前已装的本地精选件与运行前的基线比，多装的卸掉、少装的装回",
    expect: "已装的本地精选件回到运行前的清单（逐项用 plugin_list 实测核对）",
    needs: "none",
    cleanup: true,
    run: async (ctx) => {
      if (!Object.keys(ctx.state.curatedTarget || {}).length) {
        // 评审修复轮 R2：目标态表为空也按运行前的实测快照核对（F6 中途失败时表里可能没记全）
        if (!Array.isArray(ctx.state.curatedBaseline)) ctx.skip("本场景包没有动过精选件；运行前的精选件基线没取到，没法实测核对");
        const diff = await curatedDiff(ctx);
        if (!diff) ctx.skip("本场景包没有动过精选件；读不到当前的已装清单，没法实测核对");
        if (!diff.installed.length && !diff.missing.length) {
          return { 核对: "没有动过精选件（已核对：已装的本地精选件 = 运行前的基线）", 基线数: ctx.state.curatedBaseline.length };
        }
        // 实测与运行前不一致（台账里却没有）：按基线调回
        for (const id of diff.installed) ctx.state.curatedTarget[id] = "uninstalled";
        for (const id of diff.missing) ctx.state.curatedTarget[id] = "installed";
      }
      return restoreCurated(ctx);
    },
  },
];
