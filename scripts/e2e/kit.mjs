/**
 * kit.mjs —— 积木公共件：跳过语义与小工具。
 *
 * 积木（用例）统一写法（blocks/*.mjs 导出的数组元素）：
 *   {
 *     id: "I1",                         // 编号：截图/日志/06 清单对号
 *     name: "切会话点击可靠",             // 用例名称
 *     feature: "侧栏会话行",              // 涉及功能
 *     steps: "两个会话来回切 3 轮，每轮读会话头",   // 操作步骤
 *     expect: "每次会话头标题 = 所点行标题",        // 通过条件
 *     needs: "none" | "model" | "network",          // 依赖：无 / 可用模型 / 联网
 *     timeoutMs: 240000,                // 可选，单条超时
 *     cleanup: true,                    // 可选，还原类：无论前面成败都会执行
 *     run: async (ctx) => { …; return { 事实 } },  // 通过 = 正常返回；ctx.skip(原因) = 跳过；抛错 = 失败
 *   }
 * ctx 由 run.mjs 提供：app / page / expect / state（跨用例共享）/ shot(name) / fixture(name) /
 * truth(sinceMs, needles)（会话落盘真值）/ skip(reason) / warn(原因)（有一条断言没法核对时明确报出，
 * 结果标「有未核对的断言」，不算失败）/ cfg。
 *
 * 块上还可以登记 `restore: async (ctx) => {...}`：用例自己的还原动作。运行器在用例结束后一定执行它
 *（成败、超时、Ctrl+C 中断都执行；超时的用例自己的 finally 是跑不到的——那时它手里的驱动已被停用）。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export class Skip extends Error {
  constructor(reason) {
    super(String(reason));
    this.name = "Skip";
  }
}

/**
 * 把访问权限档位调回运行前的那一档，并读回核对（冒烟的 C4c、审批场景包 AP-1~AP-3 的 try/finally、
 * 块上登记的 restore、还原用例 APX-1 用的都是它）。没切过档位时如实返回「不需要还原」。
 *
 * 运行前的档位由调用方在切走**之前**记进 ctx.state.accessRestore：
 *   { fromLabel, fromMode, fromEffective, fromToolApproval }（app.readToolMode() 的读数 + 触发钮文案）。
 * 档位按**生效值**比（从未设置过 = 完全访问）：运行前是空值时，切回后后端会留下显式的「完全访问」——
 * 行为相同（都不弹审批），差异如实写进返回值，不算还原失败（产品没有「清除选择」的入口，自动化不直接改 Hub 的状态文件）。
 */
export async function restoreAccessMode(ctx) {
  const { app } = ctx;
  const saved = ctx.state.accessRestore;
  if (!saved) return { 还原: "不需要（本轮没有切过档位）" };
  // 回合还在跑时触发钮是禁用的：先停掉本用例留下的回合、拒掉它还挂着的审批卡
  for (let i = 0; i < 3 && (await app.approvalCard()); i++) await app.clickApproval("deny", "restoreAccessMode").catch(() => {});
  if (await app.turnActive()) {
    await app.page.locator('button[title="停止"]:not([disabled])').first().click({ timeout: 3000 }).catch(() => {});
    await app.waitIdle(3000, 60000).catch(() => {});
  }
  const now = await app.accessMode();
  const switched = now.label !== saved.fromLabel ? (await app.setAccessMode(saved.fromLabel)).switched : false;
  const read = await app.readToolMode();
  const label = (await app.accessMode()).label;
  if (read.effective !== saved.fromEffective || label !== saved.fromLabel) {
    throw new Error(
      `访问权限档位没有调回原档：运行前「${saved.fromLabel}」（后端值 ${JSON.stringify(saved.fromMode)}），现在触发钮「${label}」、后端值 ${JSON.stringify(read.mode)}`,
    );
  }
  delete ctx.state.accessRestore;
  const report = {
    运行前: { 档位: saved.fromLabel, 后端值: saved.fromMode, Pi审批: saved.fromToolApproval },
    还原后: { 档位: label, 后端值: read.mode, Pi审批: read.toolApproval },
    这次点了切回: switched,
    存储差异:
      read.mode === saved.fromMode
        ? "无（与运行前完全一致）"
        : `后端值由 ${JSON.stringify(saved.fromMode)} 变成 ${JSON.stringify(read.mode)}（生效档位相同：${saved.fromEffective}；产品没有「清除选择」的入口）`,
  };
  // 留一份给运行报告：用例收尾时切回了，运行器还会再调一次本函数（那时已是「不需要还原」）
  ctx.state.accessRestoreReports = [...(ctx.state.accessRestoreReports || []), report];
  return report;
}

/** PNG 尺寸（读文件头 IHDR）：[宽, 高]。 */
export function pngSize(file) {
  const buf = fs.readFileSync(file);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// 仓库 .gitignore 忽略全部 *.png——演示图不入库，运行时现画一张（四根柱子的柱状图，320×200）。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let crc = 0xffffffff;
  for (const b of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** 生成演示图（不存在才生成），返回路径。 */
export function ensureDemoPng(file) {
  if (fs.existsSync(file)) return file;
  const W = 320;
  const H = 200;
  const BG = [30, 41, 59];
  const BARS = [
    [40, 60, [56, 189, 248]],
    [110, 100, [129, 140, 248]],
    [180, 140, [244, 114, 182]],
    [250, 170, [52, 211, 153]],
  ];
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 4 + 1);
    raw[row] = 0; // 行滤波：无
    for (let x = 0; x < W; x++) {
      let rgb = BG;
      for (const [bx, bh, color] of BARS) {
        if (x >= bx && x < bx + 40 && y >= H - 20 - bh && y < H - 20) rgb = color;
      }
      const o = row + 1 + x * 4;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", zlib.deflateSync(raw)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
  return file;
}

/** 源串（npm:x@1.0 / git:host/scope/x）→ 市场卡片上显示的包名（git 源的作用域缺 @，卡片带 @）。 */
export function pkgOf(source) {
  const p = source.replace(/^(npm|git):([^/]+\/)?/, "").replace(/@[^/@]+$/, "");
  return p.includes("/") && !p.startsWith("@") ? "@" + p : p;
}
