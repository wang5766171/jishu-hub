/**
 * 积木：输入区菜单族（不需要模型与网络）。对应需求20 的 C4a/C4b/C4c。
 * 输入区的 + 菜单 / 智能体菜单 / 权限菜单是自定义实现（无 role、Esc 不关）——
 * 靠 plusMenu() 收窄范围、dismiss() 关闭。
 */
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
    name: "权限下拉（切只读再切回）",
    feature: "输入区访问权限下拉（需求10 只读披露）",
    steps: "点访问权限 → 选只读模式 → 触发钮文案变为只读 → 再点开选回完全访问",
    expect: "两向切换后触发钮文案正确，终态为完全访问",
    needs: "none",
    run: async (ctx) => {
      const { app, page, expect } = ctx;
      await app.ensureWorkspace();
      await app.closeGuideCards();
      await app.clickTitle("访问权限");
      const ro = page.getByText("只读模式", { exact: true });
      await expect(ro).toBeVisible();
      await ctx.shot("C4c-权限菜单");
      await ro.click();
      await expect(page.getByRole("button", { name: /^只读模式/ })).toBeVisible();
      await app.clickTitle("访问权限");
      await page.getByText("完全访问", { exact: true }).click();
      await expect(page.getByRole("button", { name: /^完全访问/ })).toBeVisible();
      return { 终态: "完全访问（已还原）" };
    },
  },
];
