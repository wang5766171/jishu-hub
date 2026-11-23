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
 * truth(sinceMs)（会话落盘真值）/ skip(reason) / cfg。
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
