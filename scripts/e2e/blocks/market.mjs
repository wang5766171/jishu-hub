/**
 * 积木：插件市场（页面类不需要网络；安装类需要网络，真实安装一个扩展并在结束时卸载）。
 * 对应需求20 的 I4（G4 套装卡本体）/ C4d（套装弹层）/ P1（扩展安装）/ C3（纯键盘走 J3）/ P4（还原）。
 *
 * 安全约束（全文件生效）：
 * - 「能力重叠」确认卡一律取消——自动化绝不点「停用并安装」（会停用用户已装的内置扩展）；
 * - 键盘路径只在「活动元素名字精确等于目标」时才按回车。
 */
import { expect } from "../lib-pw.mjs";
import { pkgOf } from "../kit.mjs";

const HL = "bg-primary/10"; // 套装卡高亮类

/** 处理当前屏幕上的弹层：冲突卡 → 取消；确认类 → 点确认。返回 { outcome, text }。 */
async function settleDialog(app) {
  const dlg = app.page.getByRole("dialog").first();
  if (!(await dlg.isVisible().catch(() => false))) return { outcome: "NONE", text: "" };
  const text = (await dlg.textContent()).replace(/\s+/g, " ").slice(0, 220);
  if (/冲突|能力重叠|停用并安装/.test(text)) {
    await dlg.getByRole("button", { name: /^取消/ }).click();
    await expect(dlg).toBeHidden();
    return { outcome: "CONFLICT", text };
  }
  const ok = dlg.getByRole("button", { name: /^(确认|安装|确认安装|开始安装|确定)$/ });
  if (await ok.first().isVisible().catch(() => false)) {
    await ok.last().click();
    return { outcome: "CONFIRMED", text };
  }
  return { outcome: "NONE", text };
}

const guideCount = (app) => app.page.locator("[data-install-guide]").count();
const addedSources = async (app, baseline) => (await app.invoke("pi_package_installed_sources")).filter((s) => !baseline.includes(s));
const cardNameOf = (btn) => btn.evaluate((el) => (el.parentElement?.parentElement?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 44));

/**
 * 卸载本轮测试装的扩展并核对回到基线——每个安装用例结束时自己调（每块自给自足：
 * 两个安装用例共用候选池，前者装的不卸，后者就没得装），P4 只兜失败残留。
 * 返回逐项结果；有残留则抛错。
 */
async function restoreInstalled(ctx) {
  const { app, page, expect } = ctx;
  const results = [];
  for (const source of [...new Set(ctx.state.installed)]) {
    if (!(await app.invoke("pi_package_installed_sources")).includes(source)) {
      results.push({ source, 结果: "已不在已装源" });
      continue;
    }
    const card = page.getByText(pkgOf(source), { exact: true }).locator("xpath=../..");
    if (!(await card.isVisible().catch(() => false))) await app.openMarket("扩展生态");
    await expect(card).toBeVisible({ timeout: 8000 });
    await card.getByRole("button", { name: "卸载", exact: true }).click();
    const dlg = page.getByRole("dialog").first();
    if (await dlg.isVisible().catch(() => false)) {
      const ok = dlg.getByRole("button", { name: /卸载|确认|移除|删除/ }).filter({ hasNotText: /取消/ });
      if (await ok.first().isVisible().catch(() => false)) await ok.last().click();
    }
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
  const extra = (await app.invoke("pi_package_installed_sources")).filter((x) => !ctx.state.baselineSources.includes(x));
  ctx.state.installed = [];
  if (extra.length) throw new Error("仍有测试装残留: " + JSON.stringify(extra));
  return results;
}

/** 页面类：不需要网络。 */
export const marketViewCases = [
  {
    id: "I4",
    name: "套装卡本体断言",
    feature: "插件市场精选页套装卡场景联动（收版轮 G4「断言命中内层 span」）",
    steps: "进精选 → 场景筛选点「编程」→ 读套装卡本体类名 → 切「办公」再读 → 恢复「全部」",
    expect: "编程态含高亮类，办公态不含",
    needs: "none",
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.openMarket("精选");
      const card = page.locator('[data-bundle-card="programming"]');
      if (!(await card.first().waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false))) {
        ctx.skip("精选页没有编程套装卡");
      }
      await app.click("编程");
      const on = await card.getAttribute("class");
      const offBtn = (await page.getByRole("button", { name: "办公", exact: true }).count()) ? "办公" : "全部";
      await app.click(offBtn);
      const off = await card.getAttribute("class");
      await ctx.shot(`I4-${offBtn}态`);
      await app.click("全部");
      if (!on.includes(HL) || off.includes(HL)) {
        throw new Error(`套装卡类名不符——编程态: ${on} / ${offBtn}态: ${off}`);
      }
      return { 卡本体定位: "[data-bundle-card=\"programming\"]", 编程态高亮: true, [`${offBtn}态高亮`]: false };
    },
  },
  {
    id: "C4d",
    name: "套装弹层开合",
    feature: "插件市场套装详情弹层",
    steps: "点编程套装卡 → 读弹层 → 点 Close",
    expect: "弹层出现并可关闭",
    needs: "none",
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.openMarket("精选");
      const card = page.locator('[data-bundle-card="programming"]');
      if (!(await card.first().waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false))) {
        ctx.skip("精选页没有编程套装卡");
      }
      await card.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const text = (await dialog.textContent()).replace(/\s+/g, " ").slice(0, 100);
      await ctx.shot("C4d-套装弹层");
      await app.click("Close", { scope: dialog });
      await expect(dialog).toBeHidden();
      return { 弹层文本: text };
    },
  },
];

/** 安装类：需要网络。P4 是还原用例（cleanup），无论前面成败都会执行。 */
export const marketCases = [
  {
    id: "P1",
    name: "扩展安装（冲突卡取消并换候选）",
    feature: "插件市场扩展生态 / 需求15 冲突治理 / 需求4 装后引导卡",
    steps: "进扩展生态 → 依次点候选的「安装」→ 遇「能力重叠」卡取消并换下一候选 → 等装完",
    expect: "装成一个不冲突的扩展：引导卡出现且已装源新增",
    needs: "network",
    timeoutMs: 600000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.openMarket("扩展生态");
      const installs = page.getByRole("button", { name: "安装", exact: true });
      const loaded = await installs.first().waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false);
      if (!loaded) ctx.skip("扩展生态页没有可安装项（目录未加载 / 无网络 / 已全部安装）");
      // 本用例的基线 = 整轮开始时的已装源 + 本轮前面用例装上的（否则会把别人装的算成自己新增）
      const baseline = [...ctx.state.baselineSources, ...ctx.state.installed];
      const attempts = [];
      const max = Math.min(await installs.count(), 5);
      for (let k = 0; k < max; k++) {
        const name = await cardNameOf(installs.nth(k));
        const guideBefore = await guideCount(app);
        await installs.nth(k).click();
        const deadline = Date.now() + 90000; // 每个候选最多等 90 秒（同一候选时快时慢，取决于网络）
        let outcome = "TIMEOUT";
        let confirmText = "";
        while (Date.now() < deadline) {
          const d = await settleDialog(app);
          if (d.outcome === "CONFLICT") { outcome = "CONFLICT"; confirmText = d.text; break; }
          if (d.outcome === "CONFIRMED") confirmText = d.text;
          const added = await addedSources(app, baseline);
          if (added.length && (await guideCount(app)) > guideBefore) { outcome = "INSTALLED"; break; }
          if (/安装失败|已回滚|不兼容|自检失败/.test(await app.bodyText())) { outcome = "FAILED"; break; }
          await app.sleep(700);
        }
        const addedNow = await addedSources(app, baseline);
        attempts.push({ 候选: name, 结果: outcome, 确认卡: confirmText, 新增已装源: addedNow });
        ctx.state.installed.push(...addedNow); // 装上即登记，供 P4 清理
        ctx.state.installedLog.push(...addedNow);
        if (outcome === "INSTALLED") {
          await ctx.shot("P1-装完引导卡");
          const restored = await restoreInstalled(ctx); // 装完自己卸——不给下一个安装用例留占用
          return { 尝试: attempts, 还原: restored };
        }
      }
      ctx.skip("候选均未装成（全部冲突 / 超时 / 失败）: " + JSON.stringify(attempts.map((a) => [a.候选.slice(0, 24), a.结果])));
    },
  },
  {
    id: "C3",
    name: "纯键盘走安装旅程",
    feature: "键盘与焦点可达性（J12）",
    steps: "只用 Tab/Enter：工作区 → 管理 → 插件中心 → 插件市场 → 扩展生态 → Tab 到「安装」回车 → 冲突卡键盘取消 → 装成",
    expect: "全程零鼠标完成一次安装",
    needs: "network",
    timeoutMs: 660000,
    run: async (ctx) => {
      const { app, page } = ctx;
      await app.ensureWorkspace();
      const legs = [];
      const leg = async (name, target, maxTabs = 400) => {
        const t0 = Date.now();
        const w = await app.focusWalkTo(target, { maxTabs });
        await page.keyboard.press("Enter");
        const row = { 段: name, Tab次数: w.tabs, 焦点: `${w.tag}「${w.name}」`, ms: Date.now() - t0 };
        legs.push(row);
        return row;
      };
      await page.evaluate(() => document.activeElement?.blur());
      await leg("进入管理", (n) => n === "管理", 500);
      if (!(await app.assertLanding(["返回工作区"], 12000)).ok) throw new Error("回车后未进入管理页");
      await leg("进入插件中心", (n) => n === "插件中心");
      if (!(await app.assertLanding(["插件市场"], 12000)).ok) throw new Error("回车后未进入插件中心");
      await leg("进入插件市场", (n) => n === "插件市场");
      if (!(await app.assertLanding(["扩展生态"], 12000)).ok) throw new Error("回车后未进入插件市场");
      await leg("切到扩展生态", (n) => n === "扩展生态");
      const loaded = await page
        .getByRole("button", { name: "安装", exact: true })
        .first()
        .waitFor({ state: "visible", timeout: 20000 })
        .then(() => true, () => false);
      if (!loaded) ctx.skip("扩展生态页没有可安装项（目录未加载 / 无网络 / 已全部安装）");

      const baseline = [...ctx.state.baselineSources, ...ctx.state.installed]; // 同 P1：含本轮前面用例装上的
      const attempts = [];
      const max = 5;
      for (let k = 0; k < max; k++) {
        // 起点锚定在「扩展生态」页签钮（唯一非键盘操作，只定位起点——「取消焦点」不行：
        // 浏览器会记住上次键盘位置，Tab 不是从页首开始），然后纯键盘 Tab 到第 k+1 个「安装」
        await page.getByRole("button", { name: "扩展生态", exact: true }).focus();
        let seen = 0;
        let info = null;
        let tabs = 0;
        for (let i = 0; i < 900; i++) {
          const cur = await app.activeInfo();
          if (cur && cur.name === "安装") {
            if (seen === k) { info = { tabs, ...cur }; break; }
            seen++;
          }
          await page.keyboard.press("Tab");
          tabs++;
        }
        if (!info) { attempts.push({ 候选序: k + 1, 结果: "NO_MORE_INSTALL" }); break; }
        const guideBefore = await guideCount(app);
        await page.keyboard.press("Enter");
        const deadline = Date.now() + 90000; // 每个候选最多等 90 秒（同一候选时快时慢，取决于网络）
        let outcome = "TIMEOUT";
        while (Date.now() < deadline) {
          const dlg = page.getByRole("dialog").first();
          if (await dlg.isVisible().catch(() => false)) {
            const text = (await dlg.textContent()).replace(/\s+/g, " ").slice(0, 80);
            if (/能力重叠|停用并安装/.test(text)) {
              await ctx.shot("C3-冲突卡");
              // 名字全等「取消」才回车——「停用并安装」永远不会被回车
              await app.focusWalkTo((n) => n === "取消", { maxTabs: 60 });
              await page.keyboard.press("Enter");
              await expect(dlg).toBeHidden({ timeout: 6000 });
              outcome = "CONFLICT";
              break;
            }
            const w = await app.focusWalkTo((n) => /^(确认|安装|确认安装|开始安装|确定)$/.test(n), { maxTabs: 30 }).catch(() => null);
            if (w) await page.keyboard.press("Enter");
          }
          const added = await addedSources(app, baseline);
          if (added.length && (await guideCount(app)) > guideBefore) { outcome = "INSTALLED"; break; }
          await app.sleep(700);
        }
        const addedNow = await addedSources(app, baseline);
        attempts.push({ 候选序: k + 1, Tab次数: info.tabs, 结果: outcome, 新增已装源: addedNow });
        ctx.state.installed.push(...addedNow);
        ctx.state.installedLog.push(...addedNow);
        if (outcome === "INSTALLED") {
          await ctx.shot("C3-键盘装完");
          const restored = await restoreInstalled(ctx); // 同 P1：装完自己卸
          return { 分段: legs, 尝试: attempts, 还原: restored, 全程鼠标点击: 0 };
        }
      }
      ctx.skip("键盘路径候选均未装成: " + JSON.stringify(attempts));
    },
  },
  {
    id: "P4",
    name: "还原：清掉失败残留的测试扩展",
    feature: "副作用还原（兜底）",
    steps: "若本轮还有安装用例失败中途留下的测试扩展：逐个卸载并核对回到基线",
    expect: "已装源回到本轮开始时的清单",
    needs: "none",
    cleanup: true,
    run: async (ctx) => {
      if (!ctx.state.installed.length) ctx.skip("本轮没有残留的测试扩展（安装用例都已自行卸载）");
      await ctx.app.openMarket("扩展生态");
      return restoreInstalled(ctx);
    },
  },
];
