#!/usr/bin/env node
/**
 * check-not-bundled.mjs —— 打包守卫：e2e 测试基建不得进安装包（v0.9.8 需求20，用户裁决）。
 *
 * 由 scripts/build.mjs 在前端构建之后调用（任一项命中即中止打包）；也可单独执行：
 *   node scripts/e2e/check-not-bundled.mjs              检查当前产物
 *   node scripts/e2e/check-not-bundled.mjs --selftest   自测：确认守卫真能抓到、且不误拦
 *
 * 安装包只由三样东西组成，守卫逐个查：
 *   1. dist/（前端产物，被嵌入主程序）——文件名与文本内容不得出现测试基建字样
 *   2. src-tauri/tauri.conf.json 的 bundle.resources / externalBin——不得指向 scripts/ 或 e2e
 *   3. third_party/pi-runtime.zip（随包资源）——只看包内**文件名**（解析压缩包目录，不扫内容）：
 *      出现 scripts/e2e、lib-pw 即中止；出现 playwright 字样只提示（可能是 pi 自身依赖——
 *      实测现有包里唯一一处是第三方包 package.json 里的开发依赖声明，整包不压缩存放所以
 *      按字节扫内容会误报，这就是只看文件名的原因）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const norm = (s) => s.toLowerCase().replace(/\\/g, "/");
/** dist 里禁止出现的字样（小写比对）。 */
const DIST_NEEDLES = ["playwright", "lib-pw", "connectovercdp", "scripts/e2e"];
/** pi-runtime.zip 文件名里：中止档 / 提示档。 */
const ZIP_BLOCK = ["scripts/e2e", "lib-pw"];
const ZIP_WARN = ["playwright"];
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".htm", ".json", ".map", ".txt", ".svg", ".xml", ".webmanifest"]);

const relOf = (p) => norm(path.relative(ROOT, p));
const hitsOf = (text, needles) => needles.filter((n) => text.includes(n));

function scanDist(dist) {
  const hits = [];
  if (!fs.existsSync(dist)) return { skipped: "dist/ 不存在", hits, warns: [] };
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const nameHits = hitsOf(norm(path.relative(dist, p)), DIST_NEEDLES);
      if (nameHits.length) hits.push(`${relOf(p)}  文件名含 ${nameHits.join(", ")}`);
      if (TEXT_EXT.has(path.extname(e.name).toLowerCase()) && fs.statSync(p).size <= 16 * 1024 * 1024) {
        const contentHits = hitsOf(fs.readFileSync(p, "utf8").toLowerCase(), DIST_NEEDLES);
        if (contentHits.length) hits.push(`${relOf(p)}  内容含 ${contentHits.join(", ")}`);
      }
    }
  })(dist);
  return { skipped: null, hits, warns: [] };
}

function scanTauriConf(confPath) {
  if (!fs.existsSync(confPath)) return { skipped: "tauri.conf.json 不存在", hits: [], warns: [] };
  const bundle = JSON.parse(fs.readFileSync(confPath, "utf8")).bundle || {};
  const entries = [...(bundle.resources || []), ...(bundle.externalBin || [])];
  const hits = entries.filter((e) => /scripts\/|e2e/i.test(norm(String(e)))).map((e) => `tauri.conf.json bundle 引用了 ${e}`);
  return { skipped: null, hits, warns: [] };
}

/** 读压缩包中央目录取全部文件名；不是标准结构（或 ZIP64）时返回 null。 */
function zipNamesFromCentralDirectory(fd, size) {
  const tailLen = Math.min(size, 65557 + 22);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const total = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || total === 0xffff) return null; // ZIP64
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const names = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    names.push(cd.subarray(p + 46, p + 46 + nameLen).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names.length ? names : null;
}

/** 兜底：流式扫本地文件头（签名 0x04034b50 + 文件名）。只读文件名，不读文件内容。 */
function zipNamesFromLocalHeaders(fd, size) {
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  const names = [];
  let carry = Buffer.alloc(0);
  let pos = 0;
  for (;;) {
    const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
    if (n <= 0) break;
    const buf = Buffer.concat([carry, chunk.subarray(0, n)]);
    for (let i = buf.indexOf("PK\x03\x04"); i !== -1 && i + 30 <= buf.length; i = buf.indexOf("PK\x03\x04", i + 4)) {
      const nameLen = buf.readUInt16LE(i + 26);
      if (i + 30 + nameLen <= buf.length) names.push(buf.subarray(i + 30, i + 30 + nameLen).toString("utf8"));
    }
    carry = buf.subarray(Math.max(0, buf.length - 64));
    pos += n;
  }
  return names;
}

function scanZip(zipPath) {
  if (!fs.existsSync(zipPath)) return { skipped: "pi-runtime.zip 不存在", hits: [], warns: [] };
  const fd = fs.openSync(zipPath, "r");
  let names;
  try {
    names = zipNamesFromCentralDirectory(fd, fs.fstatSync(fd).size) ?? zipNamesFromLocalHeaders(fd, fs.fstatSync(fd).size);
  } finally {
    fs.closeSync(fd);
  }
  const hits = [];
  const warns = [];
  for (const raw of names) {
    const name = norm(raw);
    const block = hitsOf(name, ZIP_BLOCK);
    const warn = hitsOf(name, ZIP_WARN);
    if (block.length && hits.length < 20) hits.push(`pi-runtime.zip 包内文件 ${raw}  含 ${block.join(", ")}`);
    if (!block.length && warn.length && warns.length < 20) warns.push(`pi-runtime.zip 包内文件 ${raw}  含 ${warn.join(", ")}`);
  }
  return { skipped: null, hits, warns };
}

function runChecks(dist, confPath, zipPath) {
  return [
    ["dist 前端产物", scanDist(dist)],
    ["tauri.conf 打包清单", scanTauriConf(confPath)],
    ["pi-runtime.zip 随包资源", scanZip(zipPath)],
  ];
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-guard-"));
  // 手工拼一个最小 zip 片段：本地文件头 + 文件名（无中央目录 → 走兜底扫描）
  const zipSample = (entries) => {
    const parts = [];
    for (const [name, content] of entries) {
      const n = Buffer.from(name);
      const c = Buffer.from(content);
      parts.push(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([n.length, 0, 0, 0]), n, c);
    }
    return Buffer.concat(parts);
  };
  const none = path.join(tmp, "none");
  try {
    // ① 干净产物：必须放行
    const cleanDist = path.join(tmp, "clean", "dist");
    fs.mkdirSync(cleanDist, { recursive: true });
    fs.writeFileSync(path.join(cleanDist, "app.js"), "console.log('clean')");
    const cleanZip = path.join(tmp, "clean.zip");
    // 第三方包 package.json 里提到 playwright（开发依赖声明）——文件名干净，不能拦
    fs.writeFileSync(cleanZip, zipSample([["node_modules/web-streams-polyfill/package.json", '{"devDependencies":{"playwright":"^1.14.1"}}']]));
    const clean = runChecks(cleanDist, none, cleanZip);
    const cleanOk = clean.every(([, r]) => r.hits.length === 0 && r.warns.length === 0);

    // ② 污染产物：三类都要抓到
    const dirtyDist = path.join(tmp, "dirty", "dist");
    fs.mkdirSync(path.join(dirtyDist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dirtyDist, "assets", "chunk.js"), "await chromium.connectOverCDP('http://127.0.0.1:9222')");
    const confBad = path.join(tmp, "tauri.conf.json");
    fs.writeFileSync(confBad, JSON.stringify({ bundle: { resources: ["../scripts/e2e/x"], externalBin: [] } }));
    const dirtyZip = path.join(tmp, "dirty.zip");
    fs.writeFileSync(dirtyZip, zipSample([["scripts/e2e/run.mjs", ""], ["node_modules/playwright/index.js", ""]]));
    const dirty = runChecks(dirtyDist, confBad, dirtyZip);
    const dirtyOk = dirty.every(([, r]) => r.hits.length > 0);
    // ③ 提示档：只出现 playwright 文件名时不拦，只提示
    const warnZip = path.join(tmp, "warn.zip");
    fs.writeFileSync(warnZip, zipSample([["node_modules/playwright/index.js", ""]]));
    const warnOnly = scanZip(warnZip);
    const warnOk = warnOnly.hits.length === 0 && warnOnly.warns.length === 1;

    for (const [label, r] of dirty) console.log(`  污染样本命中：${label} → ${r.hits.join("；")}`);
    console.log(`  提示档样本：${warnOnly.warns.join("；") || "(无提示)"} → ${warnOk ? "未拦" : "判定异常"}`);
    const ok = cleanOk && dirtyOk && warnOk;
    console.log(ok ? "守卫自测通过：干净产物放行、三类污染都能抓到、提示档只提示不拦。" : "守卫自测失败：检查逻辑有误。");
    return ok ? 0 : 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  if (process.argv.includes("--selftest")) return selftest();
  const results = runChecks(path.join(ROOT, "dist"), path.join(ROOT, "src-tauri", "tauri.conf.json"), path.join(ROOT, "third_party", "pi-runtime.zip"));
  let bad = false;
  for (const [label, r] of results) {
    if (r.skipped) {
      console.log(`  ${label}：跳过（${r.skipped}）`);
      continue;
    }
    for (const w of r.warns) console.log(`  ${label}：提示——${w}`);
    if (r.hits.length) {
      bad = true;
      console.error(`  ${label}：发现测试基建`);
      for (const h of r.hits) console.error(`    - ${h}`);
    } else console.log(`  ${label}：干净`);
  }
  if (bad) {
    console.error("e2e 测试基建混进了打包产物——已中止。安装包不应包含 scripts/e2e（需求20）。");
    return 1;
  }
  console.log("打包产物不含 e2e 测试基建。");
  return 0;
}

process.exit(main());
