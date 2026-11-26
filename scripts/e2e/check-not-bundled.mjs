#!/usr/bin/env node
/**
 * check-not-bundled.mjs —— 打包守卫：e2e 测试基建不得进安装包（v0.9.8 需求20，用户裁决）。
 *
 * 由 scripts/build.mjs 在前端构建之后调用（任一项命中即中止打包）；也可单独执行：
 *   node scripts/e2e/check-not-bundled.mjs              检查当前产物（先自测一遍，再查）
 *   node scripts/e2e/check-not-bundled.mjs --selftest   只自测：确认守卫真能抓到、且不误拦
 *
 * 安装包只由这几样东西组成，守卫逐个查：
 *   1. dist/（前端产物，被嵌入主程序）——文件名与文本内容不得出现测试基建字样
 *   2. src-tauri/tauri.conf.json 的 bundle.resources / externalBin——不得指向 scripts/ 或 e2e
 *   3. 随包资源里的压缩包（现在是 third_party/pi-runtime.zip）——只看包内**文件名**（解析压缩包目录，不扫内容）：
 *      出现 scripts/e2e、lib-pw 即中止；出现 playwright 字样只提示（可能是 pi 自身依赖——
 *      实测现有包里唯一一处是第三方包 package.json 里的开发依赖声明，整包不压缩存放所以
 *      按字节扫内容会误报，这就是只看文件名的原因）。
 *   4. 编译期嵌入主程序的 src-tauri/resources/**、安装脚本 src-tauri/nsis/*.nsh——文件名与文本内容
 *
 * 评审修复轮 R2（E-8）的加固：
 * - 产物任一缺失即失败（原来「跳过」——构建流程里它们一定先生成，缺失说明流程出了问题，不能放过）；
 * - 路径读 src-tauri/tauri.conf.json（含平台分配置）：前端产物目录取 build.frontendDist，随包资源取
 *   bundle.resources / externalBin 并展开成实际文件——配置改了路径，守卫跟着走；
 * - 压缩包的目录解析校验条目数；两路（中央目录、本地文件头）都解析不出任何条目按失败（原来结果为空也算干净）；
 * - 自测挂在守卫入口里：每次被构建调用都先自测一遍（干净放行、污染都能抓到），自测不过直接中止——
 *   守卫自身退化会在打包时暴露，不用另记一步，也不改 scripts/build.mjs。
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
/** 随包资源里：文件名不得出现的字样 / 文本内容不得出现的字样。
 *  内容这一档不查 playwright——资源里带着的技能、提示词是给人读的文档，正文提到这个词不算把测试驱动打进包。 */
const RES_NAME_NEEDLES = DIST_NEEDLES;
const RES_TEXT_NEEDLES = ["lib-pw", "connectovercdp", "scripts/e2e"];
/** pi-runtime.zip 文件名里：中止档 / 提示档。 */
const ZIP_BLOCK = ["scripts/e2e", "lib-pw"];
const ZIP_WARN = ["playwright"];
const TEXT_EXT = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".css", ".html", ".htm", ".json", ".map", ".txt", ".svg", ".xml", ".webmanifest",
]);

const relOf = (p) => norm(path.relative(ROOT, p));
const hitsOf = (text, needles) => needles.filter((n) => text.includes(n));
const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

// ── 配置与路径 ──
/**
 * 读 src-tauri 下的 Tauri 配置：tauri.conf.json + 平台分配置（tauri.windows.conf.json 之类，build / bundle
 * 两节浅合并——资源清单、外部二进制都是这两节下的数组）。读不到 / 解析不了如实返回 error。
 */
function loadTauriConfig(srcTauri) {
  const base = path.join(srcTauri, "tauri.conf.json");
  if (!fs.existsSync(base)) return { ok: false, error: `src-tauri/tauri.conf.json 不存在——守卫不知道该查哪些产物` };
  let conf;
  try {
    conf = JSON.parse(fs.readFileSync(base, "utf8"));
  } catch (e) {
    return { ok: false, error: `tauri.conf.json 解析失败：${e.message}` };
  }
  const overlays = [];
  for (const name of fs.readdirSync(srcTauri).filter((n) => /^tauri\.[a-z0-9_-]+\.conf\.json$/i.test(n)).sort()) {
    try {
      const extra = JSON.parse(fs.readFileSync(path.join(srcTauri, name), "utf8"));
      for (const key of ["build", "bundle"]) conf[key] = { ...(conf[key] || {}), ...(extra[key] || {}) };
      overlays.push(name);
    } catch (e) {
      return { ok: false, error: `${name} 解析失败：${e.message}` };
    }
  }
  return { ok: true, conf, overlays };
}

/** 极简通配符展开（只认 * 与 **，不引依赖）：返回匹配到的文件（绝对路径）。没有通配符就是「在不在」。 */
function globFiles(pattern) {
  const unified = pattern.replace(/\\/g, "/");
  if (!/[*?[\]]/.test(unified)) {
    try {
      return fs.statSync(pattern).isFile() ? [pattern] : [];
    } catch {
      return [];
    }
  }
  let base = unified;
  let rest = "";
  for (;;) {
    const at = base.lastIndexOf("/");
    const candidate = at > 0 ? base.slice(0, at) : base;
    if (!/[*?[\]]/.test(candidate)) {
      rest = base.slice(candidate.length + (at > 0 ? 1 : 0));
      base = candidate;
      break;
    }
    if (at <= 0) return [];
    base = candidate;
  }
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return [];
  const segs = rest.split("/").filter(Boolean);
  let re = "^";
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") re += last ? ".*" : "(?:[^/]+/)*";
    else re += escapeRe(seg).replace(/\*/g, "[^/]*") + (last ? "" : "/");
  });
  re += "$";
  const matcher = new RegExp(re);
  const out = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), relPath);
      else if (matcher.test(relPath)) out.push(path.join(dir, e.name));
    }
  })(base, "");
  return out;
}

/** 打包清单条目的源路径：字符串就是它自己；{ 源: 目标 } 对象取键。 */
const specOf = (raw) => (typeof raw === "string" ? raw : raw && typeof raw === "object" ? String(Object.keys(raw)[0] ?? "") : String(raw ?? ""));

/** 打包清单（resources / externalBin）里的每一项 → 实际文件。条目可以是字符串，也可以是 { 源: 目标 } 对象；路径相对 src-tauri。 */
function resolveEntries(srcTauri, entries) {
  const out = [];
  for (const raw of entries) {
    const spec = specOf(raw);
    if (!spec) continue;
    const abs = path.resolve(srcTauri, spec);
    // 目录（不带通配符）：整个目录 recursively
    if (!/[*?[\]]/.test(spec) && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else out.push({ spec, file: p });
        }
      })(abs);
      continue;
    }
    for (const file of globFiles(abs)) out.push({ spec, file });
  }
  return out;
}

// ── 各来源的检查 ──
function scanDist(dist) {
  if (!fs.existsSync(dist) || !fs.statSync(dist).isDirectory()) {
    return { skipped: null, hits: [`${dist} 不存在——守卫看不到前端产物，按失败处理（打包流程里它一定先生成；单独执行请先构建）`], warns: [] };
  }
  const hits = [];
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

function scanTauriConf(conf, srcTauri) {
  const hits = [];
  const bundle = conf.bundle || {};
  const resources = bundle.resources || [];
  const external = bundle.externalBin || [];
  const resolved = resolveEntries(srcTauri, [...resources, ...external]);
  const found = new Set(resolved.map((r) => r.spec));
  for (const e of [...resources, ...external]) {
    const spec = specOf(e);
    if (/scripts\/|e2e/i.test(norm(spec))) hits.push(`tauri.conf.json bundle 引用了 ${JSON.stringify(spec)}`);
  }
  for (const e of resources) {
    // 随包资源引用了却不存在（或通配符没匹配到任何文件）：守卫查不到它，不能当成干净。
    //（externalBin 不查存在：它的文件名带目标三元组后缀，而且是本步之后才由构建脚本拷出来的）
    const spec = specOf(e);
    if (spec && !found.has(spec)) hits.push(`打包清单引用的 ${JSON.stringify(spec)} 在仓库里不存在——守卫没法检查这一样随包资源`);
  }
  // 展开成实际文件再看一眼：配置写的是通配符、或路径拐了个弯指到 scripts/ 下时，字符串那一关看不出来
  for (const { spec, file } of resolved) {
    const rel = relOf(file);
    if (rel.startsWith("scripts/") || rel.includes("/e2e/")) hits.push(`打包清单 ${JSON.stringify(spec)} 把仓库的测试目录带了进去：${file}`);
  }
  return { skipped: null, hits, warns: [] };
}

/** 读压缩包中央目录取全部文件名与登记的条目数；不是标准结构（或 ZIP64）时返回 null。 */
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
  return { names, total };
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
  const label = relOf(zipPath) || zipPath;
  if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
    return { skipped: null, hits: [`${label} 不存在——守卫看不到随包压缩包，按失败处理`], warns: [] };
  }
  const fd = fs.openSync(zipPath, "r");
  const size = fs.fstatSync(fd).size;
  let names = [];
  const problems = [];
  try {
    if (size < 22) {
      problems.push(`${label} 只有 ${size} 字节，不是压缩包`);
    } else {
      const central = zipNamesFromCentralDirectory(fd, size);
      // 目录解析要自洽：条目数对不上、或者一条都没读出来，就退到本地文件头扫描
      if (central && central.names.length === central.total && central.names.length) names = central.names;
      else names = zipNamesFromLocalHeaders(fd, size);
    }
  } finally {
    fs.closeSync(fd);
  }
  names = [...new Set(names)];
  if (!names.length) problems.push(`${label} 的目录解析不出任何条目（文件大小 ${size} 字节）——不能当成干净`);
  const hits = problems;
  const warns = [];
  for (const raw of names) {
    const name = norm(raw);
    const block = hitsOf(name, ZIP_BLOCK);
    const warn = hitsOf(name, ZIP_WARN);
    if (block.length && hits.length < 20) hits.push(`${label} 包内文件 ${raw}  含 ${block.join(", ")}`);
    if (!block.length && warn.length && warns.length < 20) warns.push(`${label} 包内文件 ${raw}  含 ${warn.join(", ")}`);
  }
  return { skipped: null, hits, warns };
}

/** 一个目录（编译期嵌入的资源、安装脚本）：文件名与文本内容都查。目录不存在按失败（这两处是仓库里常驻的）。 */
function scanDir(dir, { nameNeedles, textNeedles }) {
  const label = relOf(dir) || dir;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { skipped: null, hits: [`${label} 不存在——守卫查不了这一处`], warns: [] };
  const hits = [];
  (function walk(cur) {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const nameHits = hitsOf(norm(path.relative(dir, p)), nameNeedles);
      if (nameHits.length) hits.push(`${relOf(p)}  文件名含 ${nameHits.join(", ")}`);
      if (TEXT_EXT.has(path.extname(e.name).toLowerCase()) && fs.statSync(p).size <= 16 * 1024 * 1024) {
        const contentHits = hitsOf(fs.readFileSync(p, "utf8").toLowerCase(), textNeedles);
        if (contentHits.length) hits.push(`${relOf(p)}  内容含 ${contentHits.join(", ")}`);
      }
    }
  })(dir);
  return { skipped: null, hits, warns: [] };
}

/** 安装脚本（src-tauri/nsis/*.nsh）：不得把 scripts/ 目录或 e2e 文件打进安装包。cli-source.nsh 是构建时生成的，跳过。 */
function scanNsh(dir) {
  const label = relOf(dir) || dir;
  if (!fs.existsSync(dir)) return { skipped: null, hits: [`${label} 不存在——守卫查不了安装脚本`], warns: [] };
  const hits = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !/\.nsh$/i.test(e.name) || e.name === "cli-source.nsh") continue;
    const p = path.join(dir, e.name);
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/scripts[\\/]|e2e/i.test(line)) hits.push(`${relOf(p)}:${i + 1}  引用了 scripts 或 e2e：${line.trim().slice(0, 100)}`);
    });
  }
  return { skipped: null, hits, warns: [] };
}

/**
 * 全部检查。参数都是为了自测能换目录：
 *   runChecks()                          查本仓库当前产物
 *   runChecks({ srcTauri, extraZips })   指定 src-tauri 目录（配置、资源、安装脚本都从它推）、额外必查的压缩包
 */
function runChecks({ srcTauri = path.join(ROOT, "src-tauri"), extraZips = [] } = {}) {
  const results = [];
  const loaded = loadTauriConfig(srcTauri);
  if (!loaded.ok) {
    results.push(["tauri.conf 配置", { skipped: null, hits: [loaded.error], warns: [] }]);
    return results;
  }
  const conf = loaded.conf;
  const how = loaded.overlays.length ? `tauri.conf.json + ${loaded.overlays.join(" + ")}` : "tauri.conf.json";
  results.push([`dist 前端产物（${how} 的 build.frontendDist）`, scanDist(path.resolve(srcTauri, String(conf.build?.frontendDist ?? "../dist")))]);
  results.push(["tauri.conf 打包清单", scanTauriConf(conf, srcTauri)]);
  const bundle = conf.bundle || {};
  const entries = [...(bundle.resources || []), ...(bundle.externalBin || [])];
  const files = resolveEntries(srcTauri, entries);
  const zips = [...new Set([...files.map((f) => f.file).filter((f) => /\.zip$/i.test(f)), ...extraZips.map((z) => path.resolve(z))])];
  for (const zip of zips) results.push([`随包压缩包 ${relOf(zip) || zip}`, scanZip(zip)]);
  // 随包资源里不是压缩包的那些：文件名与文本内容
  const loose = files.filter((f) => !/\.zip$/i.test(f.file));
  if (loose.length) {
    const hits = [];
    for (const { file } of loose) {
      const nameHits = hitsOf(norm(path.relative(ROOT, file)), RES_NAME_NEEDLES);
      if (nameHits.length) hits.push(`${file}  文件名含 ${nameHits.join(", ")}`);
      if (TEXT_EXT.has(path.extname(file).toLowerCase()) && fs.statSync(file).size <= 16 * 1024 * 1024) {
        const contentHits = hitsOf(fs.readFileSync(file, "utf8").toLowerCase(), RES_TEXT_NEEDLES);
        if (contentHits.length) hits.push(`${file}  内容含 ${contentHits.join(", ")}`);
      }
    }
    results.push(["随包资源（非压缩包）", { skipped: null, hits, warns: [] }]);
  }
  results.push(["编译期嵌入的资源（src-tauri/resources）", scanDir(path.join(srcTauri, "resources"), { nameNeedles: RES_NAME_NEEDLES, textNeedles: RES_TEXT_NEEDLES })]);
  results.push(["安装脚本（src-tauri/nsis）", scanNsh(path.join(srcTauri, "nsis"))]);
  return results;
}

function selftest({ quiet = false } = {}) {
  const say = quiet ? () => {} : console.log;
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
  // 只有「压缩包结束记录」、登记 0 个条目的空包
  const emptyZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
  const goodConf = (dist, resources) => JSON.stringify({ build: { frontendDist: dist }, bundle: { resources, externalBin: [] } });
  try {
    // ① 干净产物：必须放行
    const cleanSrc = path.join(tmp, "clean", "src-tauri");
    const cleanDist = path.join(cleanSrc, "build-out");
    fs.mkdirSync(path.join(cleanSrc, "resources", "extensions"), { recursive: true });
    fs.mkdirSync(path.join(cleanSrc, "nsis"), { recursive: true });
    fs.mkdirSync(cleanDist, { recursive: true });
    fs.writeFileSync(path.join(cleanSrc, "tauri.conf.json"), goodConf("./build-out", ["../third_party/clean.zip"]));
    fs.mkdirSync(path.join(tmp, "clean", "third_party"), { recursive: true });
    fs.writeFileSync(path.join(cleanDist, "app.js"), "console.log('clean')");
    fs.writeFileSync(path.join(cleanSrc, "resources", "extensions", "a.ts"), "export default () => {}; // 提到 playwright 不算");
    fs.writeFileSync(path.join(cleanSrc, "nsis", "installer.nsh"), "!macro customInstall\n  File /r \"${DIR}\\resources\\*\"\n!macroend");
    const cleanZip = path.join(tmp, "clean", "third_party", "clean.zip");
    // 第三方包 package.json 里提到 playwright（开发依赖声明）——文件名干净，不能拦
    fs.writeFileSync(cleanZip, zipSample([["node_modules/web-streams-polyfill/package.json", '{"devDependencies":{"playwright":"^1.14.1"}}']]));
    const clean = runChecks({ srcTauri: cleanSrc });
    const cleanOk = clean.every(([, r]) => r.hits.length === 0 && r.warns.length === 0);
    const cleanLabels = clean.map(([l]) => l);
    say(cleanLabels.map((l) => `  干净样本：${l} → 干净`).join("\n"));

    // ② 污染产物：每一处都要抓到
    const dirtySrc = path.join(tmp, "dirty", "src-tauri");
    const dirtyDist = path.join(dirtySrc, "web"); // 配置指到别的目录名——守卫要跟着配置走
    fs.mkdirSync(path.join(dirtyDist, "assets"), { recursive: true });
    fs.mkdirSync(path.join(dirtySrc, "resources", "extensions"), { recursive: true });
    fs.mkdirSync(path.join(dirtySrc, "nsis"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "dirty", "scripts", "e2e"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "dirty", "res"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "dirty", "scripts", "e2e", "run.mjs"), "// 不该进包");
    // 打包清单：一条直接引用 scripts/，一条用通配符拐到 scripts/e2e 下，一条正常的压缩包
    fs.writeFileSync(path.join(dirtySrc, "tauri.conf.json"), goodConf("./web", ["../scripts/e2e/run.mjs", "../res/**/*", "../third_party/dirty.zip"]));
    fs.writeFileSync(path.join(dirtyDist, "assets", "chunk.js"), "await chromium.connectOverCDP('http://127.0.0.1:9222')");
    fs.writeFileSync(path.join(tmp, "dirty", "res", "lib-pw.mjs"), "export {};");
    fs.writeFileSync(path.join(dirtySrc, "resources", "extensions", "x.ts"), 'import x from "/scripts/e2e/lib-pw.mjs";');
    fs.writeFileSync(path.join(dirtySrc, "nsis", "installer.nsh"), 'File /r "${PROJECT}\\scripts\\e2e\\*"\n!include cli-source.nsh');
    fs.mkdirSync(path.join(tmp, "dirty", "third_party"), { recursive: true });
    const dirtyZip = path.join(tmp, "dirty", "third_party", "dirty.zip");
    fs.writeFileSync(dirtyZip, zipSample([["scripts/e2e/run.mjs", ""], ["node_modules/playwright/index.js", ""]]));
    const dirty = runChecks({ srcTauri: dirtySrc });
    const dirtyOk = dirty.every(([, r]) => r.hits.length > 0);
    if (!quiet) for (const [label, r] of dirty) console.log(`  污染样本命中：${label} → ${r.hits.slice(0, 3).join("；")}`);

    // ③ 提示档：只出现 playwright 文件名时不拦，只提示
    const warnZip = path.join(tmp, "warn.zip");
    fs.writeFileSync(warnZip, zipSample([["node_modules/playwright/index.js", ""]]));
    const warnOnly = scanZip(warnZip);
    const warnOk = warnOnly.hits.length === 0 && warnOnly.warns.length === 1;

    // ④ 产物缺失：不再「跳过」，按命中处理
    const missingSrc = path.join(tmp, "missing", "src-tauri");
    fs.mkdirSync(path.join(missingSrc, "resources"), { recursive: true });
    fs.mkdirSync(path.join(missingSrc, "nsis"), { recursive: true });
    fs.writeFileSync(path.join(missingSrc, "tauri.conf.json"), goodConf("./not-built-yet", ["../not-packed.zip"]));
    const missing = runChecks({ srcTauri: missingSrc });
    // 这一组的 resources / nsis 两个目录是造了的（它们应当干净）；要求「前端产物缺失」「打包清单引用的压缩包不存在」两处按命中处理
    const gone = missing.filter(([label]) => /前端产物|打包清单/.test(label));
    const missingOk = gone.length >= 2 && gone.every(([, r]) => r.hits.length > 0);

    // ⑤ 压缩包目录解析不出条目：空包、以及只有 3 个字节的残包，都要按失败
    const empty = scanZip((() => {
      const p = path.join(tmp, "empty.zip");
      fs.writeFileSync(p, emptyZip);
      return p;
    })());
    const stub = scanZip((() => {
      const p = path.join(tmp, "stub.zip");
      fs.writeFileSync(p, "stub");
      return p;
    })());
    const zipOk = empty.hits.length > 0 && stub.hits.length > 0;

    // ⑥ 配置坏了 / 不在：按失败，不悄悄放过
    const noConf = runChecks({ srcTauri: path.join(tmp, "nope") });
    const confOk = noConf.every(([, r]) => r.hits.length > 0);

    const ok = cleanOk && dirtyOk && warnOk && missingOk && zipOk && confOk;
    if (!quiet) {
      console.log(`  提示档样本：${warnOnly.warns.join("；") || "(无提示)"} → ${warnOk ? "未拦" : "判定异常"}`);
      console.log(`  缺失样本：${missingOk ? "前端产物缺失、随包压缩包缺失都按命中处理" : "有漏"}｜空包 / 残包：${zipOk ? "按命中处理" : "有漏"}｜配置缺失：${confOk ? "按命中处理" : "有漏"}`);
    }
    say(ok ? "守卫自测通过：干净产物放行、各处污染都能抓到、缺失与解析不出按失败、提示档只提示不拦。" : "守卫自测失败：检查逻辑有误。");
    return ok ? 0 : 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  if (process.argv.includes("--selftest")) return selftest();
  // 守卫自身先过一遍自测：不通过就直接中止，不去查产物（守卫坏了还放行，等于没有守卫）
  if (selftest({ quiet: true }) !== 0) {
    console.error("打包守卫自测没有通过——守卫自身的检查逻辑有问题，已中止（单独执行 node scripts/e2e/check-not-bundled.mjs --selftest 看明细）。");
    return 1;
  }
  console.log("打包守卫自测通过（干净放行、污染能抓到、缺失按失败）。");
  const results = runChecks({ extraZips: [path.join(ROOT, "third_party", "pi-runtime.zip")] });
  let bad = false;
  for (const [label, r] of results) {
    for (const w of r.warns) console.log(`  ${label}：提示——${w}`);
    if (r.hits.length) {
      bad = true;
      console.error(`  ${label}：发现测试基建或产物异常`);
      for (const h of r.hits.slice(0, 20)) console.error(`    - ${h}`);
      if (r.hits.length > 20) console.error(`    - …另有 ${r.hits.length - 20} 条`);
    } else console.log(`  ${label}：干净`);
  }
  if (bad) {
    console.error("打包产物含 e2e 测试基建，或守卫没法确认某一样产物——已中止。安装包不应包含 scripts/e2e（需求20）。");
    return 1;
  }
  console.log("打包产物不含 e2e 测试基建。");
  return 0;
}

process.exit(main());
