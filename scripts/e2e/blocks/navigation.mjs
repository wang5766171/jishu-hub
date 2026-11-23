/**
 * 积木：导航与落点校验（不需要模型与网络）。对应需求20 的 I1（G3g 切会话）/ I3（S13 切项目标签）。
 * 会话与项目都自动探测——不写死任何标题。
 */
import { escapeRegExp } from "../lib-pw.mjs";

export const navigationCases = [
  {
    id: "I1",
    name: "切会话点击可靠",
    feature: "侧栏会话行（A7 R2 G3g「点成功但停错会话」）",
    steps: "自动取侧栏前两个标题唯一的会话 → 来回切换 3 轮，每次点击后读会话头",
    expect: "6 次切换的会话头标题都等于所点行标题",
    needs: "none",
    run: async (ctx) => {
      const { app } = ctx;
      await app.ensureWorkspace();
      const titles = await app.listSessionTitles(12);
      // 只取「标题在侧栏里唯一」的会话（重名行 strict 会报错，不能当目标）
      const picks = [];
      for (const t of titles) {
        if (picks.includes(t)) continue;
        const n = await app.sidebar().getByRole("button", { name: new RegExp("^" + escapeRegExp(t) + "\\s") }).count();
        if (n === 1) picks.push(t);
        if (picks.length === 2) break;
      }
      if (picks.length < 2) {
        ctx.skip(`侧栏里标题唯一的会话不足 2 个（现有 ${titles.length} 行）——先跑对话场景包或手动发两条消息`);
      }
      const heads = [];
      for (let i = 0; i < 3; i++) {
        // 落点不符时 openSession 直接抛错
        heads.push(await app.openSession({ title: picks[0] }));
        heads.push(await app.openSession({ title: picks[1] }));
      }
      await ctx.shot("I1-切会话落点");
      return { 会话: picks, 会话头序列: heads.map((h) => h.title + "#" + h.id) };
    },
  },
  {
    id: "I3",
    name: "切项目标签",
    feature: "标题栏固定项目标签（收版轮 S13「点了但没切过去」）",
    steps: "读标题栏已固定的其它项目标签 → 切到第一个 → 读侧栏项目名 → 切回原项目",
    expect: "两次切换后侧栏项目名都变成目标项目",
    needs: "none",
    run: async (ctx) => {
      const { app } = ctx;
      await app.ensureWorkspace();
      const current = await app.currentProjectName();
      const pinned = (await app.pinnedProjectLabels()).filter((l) => l !== current);
      if (!pinned.length) ctx.skip("标题栏没有其它已固定的项目标签（只有一个项目）");
      const target = pinned[0];
      const away = await app.switchProject(target, { expectName: target });
      await app.sleep(500);
      await ctx.shot("I3-切到固定项目");
      const back = await app.switchProject(current, { expectName: current });
      if (back.after === away.after) throw new Error("切回后侧栏项目名没有变化");
      return { 切到: away, 切回: back };
    },
  },
];
