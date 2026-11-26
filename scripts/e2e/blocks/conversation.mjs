/**
 * 积木：对话类（需要已配置可用模型）。对应需求20 的 C1（Enter 发送）/ I2（拖拽调序）/
 * C2（附件）/ J5（工具挂载旅程）。
 *
 * 每块自给自足：自己新建会话、自己等全部回合结束、自己读落盘真值——不依赖别的用例先跑。
 * 判定口径：「消息是否真发出 / 按什么顺序发出 / 助手是否回话」以会话落盘真值为准
 *（ctx.truth），界面计数会被侧栏与流式气泡污染。
 */
import { expect } from "../lib-pw.mjs";

/**
 * 给输入框挂一个附件：真人路径（系统剪贴板放文件 + Ctrl+V）优先；走不成时回落到合成粘贴事件
 *（非可信事件，但走应用同一条粘贴处理链），并在结果里如实写明走的是哪条路、为什么。
 *
 * 系统剪贴板是用户的（评审修复轮 R2）：驱动库占用之前先看里面是什么——图片 / 文件 / 别的非文本内容、
 * 或者读不出来（被别的进程占着）时**不占用**，直接回落；只有空剪贴板或纯文字才占用，用后还原并读回。
 * 占用了的记进 ctx.state.clipboard（报告里逐条写「已还原（读回一致）/ 未还原」）；
 * 没占用的把原因记进 ctx.state.clipboardUntouched。返回 { attached, via, clipboardRestored?, clipboardUntouched? }。
 */
async function attachFile(ctx) {
  const file = ctx.fixture("demo-chart.png");
  const fallback = (reason) => {
    ctx.state.clipboardFallback = (ctx.state.clipboardFallback || 0) + 1;
    ctx.state.clipboardFallbackReasons.push(reason);
  };
  let real;
  try {
    real = await ctx.app.attachByClipboard(file);
  } catch (e) {
    if (!/剪贴板|Clipboard|CLIXML/.test(String(e?.message || e))) throw e;
    // 占用之后才出错：驱动库已经还原过剪贴板（成没成挂在错误上）
    const restored = e.clipboardRestored === true;
    if (e.clipboardUntouched === true) ctx.state.clipboardUntouched.push(e.message);
    else ctx.state.clipboard.push({ clipboardRestored: restored });
    const reason = e.clipboardUntouched ? e.message : "系统剪贴板这条路径中途出错，剪贴板已按原内容放回";
    fallback(reason);
    const attached = await ctx.app.attachByPasteEvent(file, { name: "demo-chart.png" });
    return { attached, clipboardRestored: restored, clipboardUntouched: e.clipboardUntouched === true, via: `合成粘贴事件（${reason}）` };
  }
  if (real.clipboardUntouched) {
    // 没有占用系统剪贴板（里面是图片 / 文件 / 别的内容，或读不出来）：原因如实带进结果
    ctx.state.clipboardUntouched.push(real.reason);
    fallback(real.reason);
    const attached = await ctx.app.attachByPasteEvent(file, { name: "demo-chart.png" });
    return { attached, clipboardRestored: true, clipboardUntouched: true, via: `合成粘贴事件（${real.reason}）` };
  }
  ctx.state.clipboard.push(real);
  return { ...real, via: "系统剪贴板 + Ctrl+V" };
}

/** 新建一个测试会话（记数，供运行报告披露副作用）。 */
async function beginConversation(ctx) {
  await ctx.app.ensureWorkspace();
  await ctx.app.closeGuideCards();
  await ctx.app.newConversation();
  ctx.state.sessionsCreated += 1;
  ctx.since = Date.now();
}

/** 发出首条消息并确认回合真的启动；没启动 = 模型不可用 → 跳过并记下，后续对话用例直接跳过。 */
async function startTurn(ctx, text) {
  const { app, page } = ctx;
  if (ctx.state.modelOk === false) ctx.skip("模型不可用（本轮已判定：发送后回合未启动）");
  await beginConversation(ctx);
  await app.send(text);
  const started = await page.locator('button[title="停止"]').first().waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false);
  if (!started) {
    ctx.state.modelOk = false;
    ctx.skip("模型不可用：发送后 15 秒内回合未启动（请检查模型配置 / 网络）");
  }
  ctx.state.modelOk = true;
}

/** 等回合结束并确认真正空闲。approvals 用框架默认值（不表态）：本文件的提示词里只有 J5 可能让模型调工具，见 J5 处的说明。 */
async function finishTurn(ctx, { turnBudget = 120000, idleBudget = 120000 } = {}) {
  const turn = await ctx.app.waitTurn({ budgetMs: turnBudget });
  const idle = await ctx.app.waitIdle(4000, idleBudget);
  if (!turn.done || !idle.idle) throw new Error("回合未在时限内结束");
  return turn;
}

export const conversationCases = [
  {
    id: "C1",
    name: "回车发送消息",
    feature: "输入框键盘发送",
    steps: "新对话 → 输入文字 → 按回车（不点发送钮）→ 等回合结束",
    expect: "输入框清空、停止钮出现；落盘真值里有这条用户消息且有助手回复",
    needs: "model",
    run: async (ctx) => {
      const TEXT = "请只回复两个字：收到";
      await startTurn(ctx, TEXT);
      await expect(ctx.app.composer()).toHaveValue("");
      const turn = await finishTurn(ctx);
      const truth = await ctx.truth(ctx.since);
      if (!truth || !truth.users.includes(TEXT)) throw new Error("落盘真值里没有这条用户消息: " + JSON.stringify(truth?.users));
      if (!truth.assistants.length) throw new Error("落盘真值里没有助手回复");
      return { 发送方式: "Enter", 回合ms: turn.ms, 助手回复: truth.assistants.at(-1) };
    },
  },
  {
    id: "I2",
    name: "拖拽调序生效",
    feature: "流式中暂存消息的拖拽排序（A7 R2「合成 DragEvent 未生效」）",
    steps: "新对话发一个长任务 → 等会话 id 解析 → 暂存两条 → 把第二条拖到第一条位置 → 等全部投递",
    expect: "暂存卡片顺序反转；落盘真值里「第二条」排在「第一条」之前",
    needs: "model",
    run: async (ctx) => {
      const { app } = ctx;
      // 任务要足够长：本用例要求「暂存时回合还在进行」——数到 400 在模型快时 8 秒就结束，
      // 等 id 解析后再暂存就已经晚了（消息被直接发送，暂存区为空）。
      await startTurn(ctx, "请从 1 数到 1500，每个数字单独一行，其他什么都不要说。");
      // 先等 id 解析：本用例只验证拖拽调序（变量单一）；「解析完成前暂存」由 fixround 场景包的 F2 验证
      await app.waitSessionResolved(15000);
      await app.sleep(1200);
      await app.send("第一条暂存：只回复「一」");
      await expect(app.stagedGrips()).toHaveCount(1, { timeout: 8000 }); // 等第一条真正进暂存区再输第二条
      await app.send("第二条暂存：只回复「二」");
      await expect(app.stagedGrips()).toHaveCount(2, { timeout: 8000 });
      const before = await app.stagedTexts();
      await ctx.shot("I2-拖拽前");
      await app.stagedGrips().nth(1).dragTo(app.stagedRows().nth(0));
      const after = await app.stagedTexts();
      await ctx.shot("I2-拖拽后");
      if (!(after[0]?.includes("第二条") && after[1]?.includes("第一条"))) {
        throw new Error("暂存顺序未反转: " + JSON.stringify({ before, after }));
      }
      await finishTurn(ctx, { turnBudget: 240000, idleBudget: 240000 });
      const truth = await ctx.truth(ctx.since);
      const i1 = truth?.users.findIndex((u) => u.includes("第一条暂存")) ?? -1;
      const i2 = truth?.users.findIndex((u) => u.includes("第二条暂存")) ?? -1;
      if (i1 < 0 || i2 < 0 || !(i2 < i1)) throw new Error("落盘真值未按反转顺序投递: " + JSON.stringify(truth?.users));
      return { 拖拽前: before, 拖拽后: after, 落盘顺序: truth.users.map((u) => u.slice(0, 14)) };
    },
  },
  {
    id: "C2",
    name: "附件上传（剪贴板文件粘贴）",
    feature: "输入框附件（真人路径：系统剪贴板放文件 + Ctrl+V）",
    steps: "新对话 → 剪贴板放入演示图 → 输入框 Ctrl+V → 补正文 → 回车 → 等回合结束",
    expect: "输入框占位文案变化（附件挂上）；消息流出现图片；落盘真值里有这条消息",
    needs: "model",
    run: async (ctx) => {
      const { app, page } = ctx;
      if (process.platform !== "win32") ctx.skip("附件真人路径仅 Windows");
      if (ctx.state.modelOk === false) ctx.skip("模型不可用（本轮已判定）");
      await beginConversation(ctx);
      const att = await attachFile(ctx);
      if (!att.attached) ctx.skip("附件未挂上（当前智能体可能不支持附件）");
      await ctx.shot("C2-附件挂上");
      await app.type("这张图里有几根柱子？只回答数字。", { append: true });
      await app.composer().press("Enter");
      const started = await page.locator('button[title="停止"]').first().waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false);
      if (!started) {
        ctx.state.modelOk = false;
        ctx.skip("模型不可用：发送后 15 秒内回合未启动");
      }
      ctx.state.modelOk = true;
      const turn = await finishTurn(ctx);
      const imgs = await page.locator('img[src^="data:image"]').count();
      const truth = await ctx.truth(ctx.since);
      if (!truth?.users.some((u) => u.includes("这张图里有几根柱子"))) throw new Error("落盘真值里没有这条消息");
      await ctx.shot("C2-图片消息");
      const clipboard = att.clipboardUntouched ? `没有占用（${att.via}）` : att.clipboardRestored ? "占用过，已还原（读回一致）" : "占用过，未还原";
      return { 挂载方式: att.via, 系统剪贴板: clipboard, 回合ms: turn.ms, 页面图片数: imgs };
    },
  },
  {
    id: "J5",
    name: "工具挂载旅程",
    feature: "加号菜单挂载工具 → 胶囊 → 附件 → 发送（需求7/需求9 路线甲）",
    steps: "新对话 → 加号菜单选一个可挂载项（有平铺项点平铺项，否则进 Skill 子菜单）→ 挂附件 → 补正文 → 回车 → 等回合结束",
    expect: "输入框出现 @[名]；落盘首条用户消息保留 @[名] 字样",
    needs: "model",
    run: async (ctx) => {
      const { app, page } = ctx;
      const BAD = /^(附件|Skill|MCP|扩展|插件工具|输入素材|能力挂载)$/;
      await beginConversation(ctx);
      await app.clickTitle("添加上下文");
      const menu = app.plusMenu();
      await expect(menu.getByText("能力挂载", { exact: true })).toBeVisible();
      const items = menu.getByRole("button");
      const flat = [];
      for (let i = 0; i < (await items.count()); i++) {
        const t = (await items.nth(i).textContent()).trim();
        if (t && !BAD.test(t)) flat.push(t);
      }
      let picked;
      let viaSubmenu = false;
      if (flat.length) {
        picked = flat[0];
      } else {
        const sub = menu.getByRole("button", { name: "Skill", exact: true });
        if (!(await sub.isVisible().catch(() => false))) ctx.skip("加号菜单里没有可挂载的工具项");
        viaSubmenu = true;
        await sub.click();
        const skills = [];
        const all = menu.getByRole("button");
        for (let i = 0; i < (await all.count()); i++) {
          const t = (await all.nth(i).textContent()).trim();
          if (t && !BAD.test(t)) skills.push(t);
        }
        if (!skills.length) ctx.skip("Skill 子菜单为空（未安装技能）");
        picked = skills[0];
      }
      await menu.getByRole("button", { name: picked, exact: true }).click();
      await expect(app.composer()).toHaveValue(/@\[/);
      await ctx.shot("J5-胶囊注入");
      await app.dismiss();
      if (ctx.state.modelOk === false) ctx.skip(`已挂载「${picked}」；模型不可用，发送段跳过`);
      if (process.platform === "win32") {
        // 挂不上不阻断：附件已由 C2 单独验证（占没占用剪贴板、走没走成真人路径，attachFile 里已记账）
        await attachFile(ctx);
      }
      // 这条提示词会让模型去用挂上的工具。挂的是哪个工具运行时才知道——审批档下它可能弹审批卡：
      // 框架不替用户放行一个不认识的工具，等回合用默认值（不表态），真弹了用例失败并写明；
      // 断言（胶囊、落盘保留 @[名]）本身不依赖工具真的执行。
      await app.type("请用刚才挂载的工具告诉我你能做什么，一句话即可。", { append: true });
      await app.composer().press("Enter");
      const started = await page.locator('button[title="停止"]').first().waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false);
      if (!started) {
        ctx.state.modelOk = false;
        ctx.skip(`已挂载「${picked}」；模型不可用，发送段跳过`);
      }
      ctx.state.modelOk = true;
      const turn = await finishTurn(ctx);
      const truth = await ctx.truth(ctx.since);
      const first = truth?.users[0] ?? "";
      if (!first.includes(`@[${picked}]`)) throw new Error("落盘首条消息未保留 @[名] 字样: " + JSON.stringify(truth?.users));
      return { 挂载: picked, 经子菜单: viaSubmenu, 回合ms: turn.ms, 落盘首条: first.slice(0, 60) };
    },
  },
];
