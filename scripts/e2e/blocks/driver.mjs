/**
 * 积木：驱动库自身能力（不需要模型与网络）。
 * 对应需求20 的 D1~D7：附着 / 可信事件 / 命中测试 / strict / 截图口径 / 契约直调 / 错误捕获。
 */
import fs from "node:fs";
import { open, DEFAULT_VIEWPORT } from "../lib-pw.mjs";
import { pngSize } from "../kit.mjs";

const TRUSTED = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];

export const driverCases = [
  {
    id: "D1",
    name: "附着与页面发现",
    feature: "驱动库 open/close",
    steps: "读当前附着页面地址 → 再开一条附着 → 断开第二条",
    expect: "两条附着落在同一应用页面（tauri.localhost 或 localhost 开发地址）",
    needs: "none",
    run: async (ctx) => {
      const url1 = ctx.page.url();
      const probe = await open({ log: () => {}, viewport: null });
      const url2 = probe.page.url();
      await probe.close();
      if (url1 !== url2 || !/^https?:\/\/(tauri\.localhost|localhost:\d+)/.test(url1)) {
        throw new Error(`附着页面异常: ${url1} / ${url2}`);
      }
      return { 页面: url1, 双附着一致: true };
    },
  },
  {
    id: "D2",
    name: "可信事件五连发",
    feature: "驱动库点击（CDP Input 域）",
    steps: "页面内注册捕获探针 → 真实点击侧栏搜索框 → 读事件序列",
    expect: "pointerdown/mousedown/pointerup/mouseup/click 各一次且全为 isTrusted:true",
    needs: "none",
    run: async ({ app, page }) => {
      await app.ensureWorkspace();
      await page.evaluate((types) => {
        window.__pwTrust = [];
        window.__pwHandlers = [];
        for (const t of types) {
          const h = (e) => window.__pwTrust.push(t + ":" + e.isTrusted);
          document.addEventListener(t, h, true);
          window.__pwHandlers.push([t, h]);
        }
      }, TRUSTED);
      await app.sidebar().locator("input").first().click(); // 惰性目标
      const seq = await page.evaluate(() => {
        for (const [t, h] of window.__pwHandlers) document.removeEventListener(t, h, true);
        return window.__pwTrust;
      });
      const need = TRUSTED.map((t) => t + ":true");
      if (!need.every((s, i) => seq[i] === s)) throw new Error("事件序列不符: " + JSON.stringify(seq));
      return { 序列: seq };
    },
  },
  {
    id: "D3",
    name: "命中测试不再静默",
    feature: "驱动库点击前命中检查",
    steps: "页面内临时盖一层透明遮罩 → 点击被遮住的侧栏搜索框 → 移除遮罩",
    expect: "驱动报「intercepts pointer events」类错误，不假装点成功",
    needs: "none",
    run: async ({ app, page }) => {
      await app.ensureWorkspace();
      await page.evaluate(() => {
        const cover = document.createElement("div");
        cover.id = "__pw_cover";
        cover.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:transparent";
        document.body.appendChild(cover);
      });
      let msg = "";
      try {
        await app.sidebar().locator("input").first().click({ timeout: 2500 });
      } catch (e) {
        msg = String(e.message);
      } finally {
        await page.evaluate(() => document.getElementById("__pw_cover")?.remove());
      }
      if (!/intercepts pointer events/.test(msg)) throw new Error("未报遮挡类错误: " + msg.slice(0, 200));
      return { 报错: (msg.split("\n").find((l) => l.includes("intercepts pointer events")) || "").trim().slice(0, 120) };
    },
  },
  {
    id: "D4",
    name: "多命中报错不猜",
    feature: "驱动库定位器 strict mode",
    steps: "对页面上全部按钮发起一次点击 → 再用「角色 + 精确名」收窄定位「新对话」",
    expect: "宽定位报 strict mode violation；收窄后恰好 1 个",
    needs: "none",
    run: async ({ app, page }) => {
      await app.ensureWorkspace();
      let msg = "";
      try {
        await page.locator("button").click({ timeout: 2500 });
      } catch (e) {
        msg = String(e.message);
      }
      if (!/strict mode violation/.test(msg)) throw new Error("未报 strict mode violation: " + msg.slice(0, 200));
      const n = await page.getByRole("button", { name: "新对话", exact: true }).count();
      if (n !== 1) throw new Error("收窄后「新对话」命中数 = " + n);
      return { 宽定位报错: true, 收窄后命中数: n };
    },
  },
  {
    id: "D5",
    name: "截图口径零破坏",
    feature: "驱动库截图",
    steps: "shot() 落盘一张 → 读 PNG 文件头",
    expect: `尺寸 ${DEFAULT_VIEWPORT.width}×${DEFAULT_VIEWPORT.height}（非缩放屏的物理像素）`,
    needs: "none",
    run: async (ctx) => {
      await ctx.app.ensureWorkspace();
      const file = await ctx.shot("D5-截图口径");
      const [w, h] = pngSize(file);
      if (w !== DEFAULT_VIEWPORT.width || h !== DEFAULT_VIEWPORT.height) throw new Error(`尺寸不符: ${w}x${h}`);
      return { 尺寸: `${w}x${h}`, 字节: fs.statSync(file).size };
    },
  },
  {
    id: "D6",
    name: "契约直调照旧",
    feature: "Tauri 命令直调（跨端契约锚定）",
    steps: "直调 market_list_bundles 读套装清单 → 直调 task_artifacts_list 查不存在的任务",
    expect: "套装清单为数组且每项含 id/title/items[{ref,required}]；不存在的任务返回空数组",
    needs: "none",
    run: async ({ app }) => {
      const bundles = await app.invoke("market_list_bundles");
      const shapeOk =
        Array.isArray(bundles) &&
        bundles.length > 0 &&
        bundles.every((b) => typeof b.id === "string" && typeof b.title === "string" && Array.isArray(b.items) && b.items.every((it) => "ref" in it && typeof it.required === "boolean"));
      if (!shapeOk) throw new Error("market_list_bundles 契约不符: " + JSON.stringify(bundles).slice(0, 200));
      const empty = await app.invoke("task_artifacts_list", { projectRoot: process.cwd(), taskId: "no-such-task" });
      if (!Array.isArray(empty) || empty.length !== 0) throw new Error("task_artifacts_list 空目录应返回 []: " + JSON.stringify(empty));
      return { 套装数: bundles.length, 首个套装: bundles[0].title, 空目录: empty.length };
    },
  },
  {
    id: "D7",
    name: "错误捕获跨 reload 存活",
    feature: "驱动库错误捕获",
    steps: "页面内 console.error → reload → 再 console.error",
    expect: "两次都被捕获（用 console.error 而非未捕获异常：后者会触发应用全局错误页）",
    needs: "none",
    run: async ({ app, page }) => {
      await app.ensureWorkspace();
      app.errors.length = 0;
      await page.evaluate(() => console.error("E2E_D7_before"));
      await page.waitForTimeout(400);
      const before = app.errors.filter((e) => e.includes("E2E_D7_before")).length;
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".chat-sidebar", { timeout: 15000 });
      await page.waitForTimeout(1200);
      await page.evaluate(() => console.error("E2E_D7_after"));
      await page.waitForTimeout(500);
      const after = app.errors.filter((e) => e.includes("E2E_D7_after")).length;
      if (!before || !after) throw new Error(`捕获缺失 before=${before} after=${after}`);
      return { reload前: before, reload后: after };
    },
  },
];
