/**
 * 积木：输入区菜单族（不需要模型与网络）。对应需求20 的 C4a/C4b/C4c。
 * 输入区的 + 菜单 / 智能体菜单 / 权限菜单是自定义实现（无 role、Esc 不关）——
 * 靠 plusMenu() 收窄范围、dismiss() 关闭。
 * C4c 会切换访问权限档位（写 Hub 状态与 Pi 设置）：用例内 try/finally 切回并读回，有回合在跑时跳过。
 */
import { restoreAccessMode } from "../kit.mjs";

const GROUP_LABELS = /^(附件|Skill|MCP|扩展|插件工具|输入素材|能力挂载)$/;

/** 列出 + 菜单弹层内的按钮文字（排除组标签与子菜单触发器）。 */
async function flatItems(app) {
  const items = app.plusMenu().getByRole("button");
  const out = [];
  for (let i = 0; i < (await items.count()); i++) {
    const t = (await items.nth(i).textContent()).trim();
    if (t && !GROUP_LABELS.test(t)) out.push(t);
  }
  return out;
}

export const composerCases = [
  {
    id: "C4a",
    name: "加号菜单结构与挂载胶囊",
    feature: "输入区 + 菜单 / Skill 子菜单（需求7）",
    steps: "点 + 号 → 断言「输入素材」「能力挂载」两组 → 点一个可挂载项（有平铺项点平铺项，否则进 Skill 子菜单点第一项）",
    expect: "两组标签可见；选中后输入框出现 @[名] 胶囊",
    needs: "none",
    run: async (ctx) => {
      const { app, expect } = ctx;
      await app.ensureWorkspace();
      await app.closeGuideCards();
      await app.composer().fill("");
      await app.clickTitle("添加上下文");
      const menu = app.plusMenu();
      await expect(menu.getByText("输入素材", { exact: true })).toBeVisible();
      await expect(menu.getByText("能力挂载", { exact: true })).toBeVisible();
      await expect(menu.getByRole("button", { name: "附件", exact: true })).toBeVisible();
      const flat = await flatItems(app);
      let picked;
      let viaSubmenu = false;
      if (flat.length) {
        picked = flat[0];
        await menu.getByRole("button", { name: picked, exact: true }).click();
      } else {
        const sub = menu.getByRole("button", { name: "Skill", exact: true });
        if (!(await sub.isVisible().catch(() => false))) ctx.skip("加号菜单里没有可挂载的工具项");
        viaSubmenu = true;
        await sub.click();
        const skills = await flatItems(app);
        if (!skills.length) ctx.skip("Skill 子菜单为空（未安装技能）");
        picked = skills[0];
        await menu.getByRole("button", { name: picked, exact: true }).click();
      }
      await expect(app.composer()).toHaveValue(/@\[/);
      const value = await app.composer().inputValue();
      await ctx.shot("C4a-胶囊注入");
      await app.dismiss();
      await app.composer().fill("");
      return { 点了: picked, 经子菜单: viaSubmenu, 输入框: value.slice(0, 60) };
    },
  },
  {
    id: "C4b",
    name: "智能体切换菜单",
    feature: "输入区智能体切换",
    steps: "点智能体切换钮 → 读菜单项 → 关菜单（不改选择）",
    expect: "菜单展开且含带版本号的智能体项；关闭后菜单消失",
    needs: "none",
    run: async (ctx) => {
      const { app, page, expect } = ctx;
      await app.ensureWorkspace();
      await app.closeGuideCards();
      const title = await app.agentSwitchTitle();
      if (!title) ctx.skip("未找到智能体切换钮");
      const versioned = () =>
        page.evaluate(() =>
          [...document.querySelectorAll("button")]
            .filter((b) => b.getBoundingClientRect().height > 0 && /\d+\.\d+\.\d+/.test(b.textContent || ""))
            .map((b) => (b.textContent || "").trim().slice(0, 40)),
        );
      const before = await versioned();
      await app.clickTitle(title);
      await expect
        .poll(async () => (await versioned()).length, { timeout: 5000 })
        .toBeGreaterThan(before.length);
      const names = (await versioned()).filter((n) => !before.includes(n));
      await ctx.shot("C4b-智能体菜单");
      await app.dismiss();
      await expect
        .poll(async () => (await versioned()).length, { timeout: 5000 })
        .toBe(before.length);
      return { 触发钮: title, 菜单项: names.slice(0, 6) };
    },
  },
  {
    id: "C4c",
    name: "权限下拉（切到另一档再切回，读回核对）",
    feature: "输入区访问权限下拉（需求10 只读披露）/ 副作用还原",
    steps: "读当前档位与后端值 → 有回合在跑就跳过 → 读菜单里的档位 → 点访问权限选另一档 → 触发钮文案变为该档、后端值跟着变 → finally 再点开选回原档 → 读回档位与触发钮文案",
    expect: "两向切换后触发钮文案正确；终态回到运行前的档位（档位读回与触发钮文案都对上，断言失败也会切回）；不假设、也不改动用户原有设置",
    needs: "none",
    // 用例超时 / 被中断时它自己的 finally 跑不到（手里的驱动已被停用）——运行器按这个登记替它切回原档
    restore: restoreAccessMode,
    run: async (ctx) => {
      const { app, page, expect } = ctx;
      await app.ensureWorkspace();
      await app.closeGuideCards();
      // 当前档位是用户环境的既有状态（可能本来就停在只读）——先读出来，切走之前就登记好怎么切回
      const access = await app.accessMode();
      if (!access.switchable) ctx.skip(`当前智能体不支持切换访问权限档位（触发钮：${access.label || "找不到"}）`);
      // 切档是产品行为：会重启该智能体全部会话的引擎进程——有回合在跑就不在这个时候切
      const running = await app.invoke("chat_active_sessions").catch(() => []);
      if (Array.isArray(running) && running.length) ctx.skip(`有 ${running.length} 个会话的回合还在进行——切档会重启引擎进程、打断它们；等它们结束再跑`);
      const before = await app.readToolMode();
      const options = await app.accessModeOptions();
      const initial = access.label;
      // 原先写死「只读 ↔ 完全访问」：另一档从菜单里挑（先挑这两档，都不在就挑任意一个别的档）
      const other =
        [initial.startsWith("只读") ? "完全访问" : "只读模式", "只读模式", "完全访问"].find((label) => label !== initial && options.includes(label)) ??
        options.find((label) => label !== initial);
      if (!other) ctx.skip(`权限菜单里除了当前这一档没有别的档位（菜单：${options.join("、") || "读不到"}）`);
      ctx.state.accessRestore = { fromLabel: initial, fromMode: before.mode, fromEffective: before.effective, fromToolApproval: before.toolApproval };
      try {
        await app.clickTitle("访问权限");
        // 菜单项与触发钮文字相同（当前档位就是这一档时）：排除触发钮内部再找
        const menuItem = (label) => page.locator(`:text-is('${label}'):not([title='访问权限'] *)`);
        await expect(menuItem(other)).toBeVisible();
        await ctx.shot("C4c-权限菜单");
        await menuItem(other).click();
        await expect(page.locator('button[title="访问权限"]').first()).toHaveText(other, { timeout: 20000 });
        // 后端的值要跟着变（菜单项与后端声明的档位值同序）
        const expected = (before.modes ?? [])[options.indexOf(other)] ?? null;
        const mid = await app.readToolMode();
        if (expected && mid.effective !== expected) throw new Error(`切到「${other}」后，后端的档位没有跟着变：读回 ${JSON.stringify(mid.mode)}，应为 ${JSON.stringify(expected)}`);
      } finally {
        // 评审修复轮 R2：断言失败也必须切回原档（原来没有 finally，失败一次就把用户的权限档留在另一档）
        await restoreAccessMode(ctx).catch((e) => ctx.warn(`用例收尾时没能切回原档：${e?.message || e}`));
      }
      const report = ctx.state.accessRestoreReports?.at(-1);
      return { 运行前: initial, 切到: other, 终态: report?.还原后?.档位, 后端读回: report?.还原后?.后端值, 存储差异: report?.存储差异 };
    },
  },
];
