import { spawnSync } from "node:child_process";
import { cpSync, rmSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, createWriteStream, realpathSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import archiver from "archiver";
import { fixShebang, readRuntimeDeps } from "./lib/pi-common.mjs";

const root = resolve(process.cwd());
const piRoot = resolve(root, "third_party", "pi");
const piBundle = resolve(root, "third_party", "pi-bundle");

// 子步骤失败必须大声失败（2026-08-30 事故复盘）。任何一步非零退出立即终止打包。
function runStep(label, args, cwd) {
  const result = spawnSync("npm", args, { cwd, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`\n[pack-pi] FAILED at step: ${label} (exit ${result.status})`);
    console.error("[pack-pi] 上一行起的报错即根因；pi-bundle 不会被打进安装包。");
    process.exit(result.status ?? 1);
  }
}

// ── 增量构建守卫（2026-09-09 用户裁决）─────────────────────────────
// pi 源码 commit 未变 且 pi-bundle 关键产物完整时跳过重构建。
// 全量重建需 PI_SKIP_CACHE=1（涉及 pi 内部 dist 重建时使用）。
const piStampFile = join(piBundle, ".pi-build-stamp");

function getPiCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: piRoot, encoding: "utf-8" });
  return result.status === 0 && result.stdout ? result.stdout.trim() : null;
}

function piBundleIsValid() {
  const checks = [
    join(piBundle, "packages", "coding-agent", "dist", "bundle", "cli.js"),
    join(piBundle, "packages", "coding-agent", "dist", "runtime-deps.json"),
    join(piBundle, "packages", "ai", "dist", "providers", "data", "anthropic.json"),
    join(piBundle, "bin"),
  ];
  return checks.every((p) => existsSync(p));
}

function shouldSkipRebuild() {
  if (process.env.PI_SKIP_CACHE === "1") return false;
  const commit = getPiCommit();
  if (!commit) return false;
  if (!existsSync(piStampFile)) return false;
  const stamp = readFileSync(piStampFile, "utf-8").trim();
  if (stamp !== commit) return false;
  return piBundleIsValid();
}

console.log("Preparing pi-bundle...");

if (shouldSkipRebuild()) {
  console.log(`[pack-pi] pi commit unchanged (${getPiCommit()?.slice(0, 8)}…) and bundle valid — skipping rebuild.`);
  console.log("[pack-pi] (set PI_SKIP_CACHE=1 to force full rebuild)");
} else {
  // ── 全量重建路径 ──
  // 1. Remove old pi-bundle
  if (existsSync(piBundle)) {
    rmSync(piBundle, { recursive: true, force: true });
  }

  // 2. Copy pi to pi-bundle（含 dist——跳过 generate-models 等网络依赖步骤，
  //    使用源码树已构建的 dist；pi 内部代码变更时需先在 pi 源码树构建 dist）
  console.log("Copying pi source (including pre-built dist)...");
  cpSync(piRoot, piBundle, {
    recursive: true,
    filter: (src) => {
      const name = src.split(/[\\/]/).pop();
      if (['node_modules', '.git', '.github', '.husky'].includes(name)) return false;
      return true;
    }
  });

  // 2b. 校验源码树 dist 是否存在（不存在则要求先构建 pi）
  const sourceCli = join(piRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
  if (!existsSync(sourceCli)) {
    console.error("[pack-pi] pi source tree has no pre-built dist (cli.js missing).");
    console.error("[pack-pi] Run the following first, then retry:");
    console.error("[pack-pi]   cd third_party/pi && npm install && npm run build");
    process.exit(1);
  }

  // 3. Install dependencies in pi-bundle
  console.log("Installing dependencies in pi-bundle...");
  runStep("npm install (pi-bundle)", ["install", "--ignore-scripts"], piBundle);

  // 4. Prune dev dependencies（跳过 npm run build——dist 已随源码复制）
  console.log("Pruning dev dependencies...");
  runStep("npm prune (pi-bundle)", ["prune", "--omit=dev"], piBundle);

  // 写入构建标记（下次同 commit 跳过重构建）
  const commit = getPiCommit();
  if (commit) {
    writeFileSync(piStampFile, commit);
    console.log(`[pack-pi] stamped commit ${commit.slice(0, 8)}…`);
  }
}

// ── 以下步骤每次都执行（幂等）──

// 5. Clean up source files to obfuscate and reduce size
console.log("Cleaning up source files...");
const dirsToClean = [
  "src", "tests", "examples"
];
const filesToClean = [
  "tsconfig.json", "tsconfig.base.json", "tsconfig.build.json", "tsconfig.node.json",
  "pi-test.bat", "pi-test.ps1", "pi-test.sh", "test.sh", "jest.config.js", "jest.config.ts"
];

function cleanDirectory(dir) {
  if (!existsSync(dir)) return;
  const items = readdirSync(dir);
  for (const item of items) {
    const fullPath = join(dir, item);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (dirsToClean.includes(item) || item.endsWith(".test") || item.endsWith(".spec")) {
        rmSync(fullPath, { recursive: true, force: true });
      } else if (item !== "node_modules") {
        cleanDirectory(fullPath);
      }
    } else {
      if (filesToClean.includes(item) || fullPath.endsWith(".ts") && !fullPath.endsWith(".d.ts")) {
        rmSync(fullPath, { force: true });
      }
    }
  }
}

cleanDirectory(piBundle);

// 5.5 Fix double shebang in entry points
console.log("Fixing double shebangs...");
fixShebang(join(piBundle, "packages", "coding-agent", "dist"));

// 5.6 Embed portable Node.js runtime
const nodeBinDir = join(piBundle, "bin");
const nodeBinaryName = process.platform === "win32" ? "node.exe" : "node";
const nodeSource = process.execPath;
if (existsSync(nodeSource)) {
  if (!existsSync(nodeBinDir)) {
    cpSync(nodeSource, join(nodeBinDir, nodeBinaryName));
    console.log(`Embedded portable node: ${nodeSource} → ${nodeBinDir}/${nodeBinaryName}`);
  }
} else {
  console.warn(`WARNING: cannot find node binary at ${nodeSource} to embed.`);
}

// 5.65 v0.9.7 需求8 修复A：解引用全部 symlink/junction 为实体拷贝。
// npm workspace 在 node_modules 里放的 @earendil-works/* 等是链接（Windows
// junction / unix symlink）——archiver glob 会把它们写成 zip symlink 条目，
// 而 Rust 解压器（extract_zip_to_temp）不识别 symlink，会把「目标路径文本」
// 当文件内容写出（subagent 的 dist/core 散模块 import 随即 Cannot find
// package）。根治 = 打包前全部换成实体目录，zip 里不再有链接条目。
console.log("Dereferencing symlinks/junctions to real copies...");
const dereferenced = dereferenceLinks(piBundle);
if (dereferenced > 0) {
  console.log(`Dereferenced ${dereferenced} link entries (e.g. npm workspace packages).`);
}
// 断言：全树再扫一遍必须零链接（防未来 npm 行为变化悄悄退化——fail loud）。
const remaining = collectLinkEntries(piBundle);
if (remaining.length > 0) {
  console.error(
    `[pack-pi] FAILED: ${remaining.length} symlink/junction entries remain after dereference:\n` +
      remaining.slice(0, 10).map(([p, real]) => `  ${p} -> ${real}`).join("\n") +
      `\n[pack-pi] 提示：若仓库/构建路径本身含符号链接（subst、网盘同步、junction 挂载），` +
      `请改用真实路径重跑；连续两轮仍残留多为解引用失败（权限/占用）。`
  );
  process.exit(1);
}

// 全树收集链接条目。评审十一修复误判：判定改为「realpath 相对**父目录
// realpath** 的子路径名 ≠ 自身名」——只有条目自身是 symlink/junction 才会
// 指向别处。旧实现拿整路径 realpath 与字面量比对，仓库路径本身含符号链接
// （subst/网盘同步/junction 挂载的构建目录）时父段永远不一致 → 全树皆
// 假阳性、解引用死循环式报错。Windows junction 不报 lstat.isSymbolicLink，
// 必须靠 realpath 比对（大小写不敏感）。
// 返回 [fullPath, realPath][]；不递归进链接本体（避免重复遍历目标内容）。
function collectLinkEntries(rootDir) {
  const links = [];
  const walk = (dir) => {
    let parentReal;
    let items;
    try {
      parentReal = realpathSync(dir);
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = join(dir, item.name);
      let real;
      try {
        real = realpathSync(full);
      } catch {
        continue; // 失效链接（目标不存在）留给步骤 6 清理
      }
      // 非链接条目的 realpath 必为 <父realpath>/<自身名>——偏离（含 ../ 逃逸、
      // 指向兄弟/外部）即条目自身是链接。
      if (relative(parentReal, real).toLowerCase() !== item.name.toLowerCase()) {
        links.push([full, real]);
        continue;
      }
      if (item.isDirectory()) walk(full);
    }
  };
  walk(rootDir);
  return links;
}

function dereferenceLinks(rootDir) {
  const links = collectLinkEntries(rootDir);
  for (const [linkPath, realPath] of links) {
    rmSync(linkPath, { recursive: true, force: true });
    cpSync(realPath, linkPath, { recursive: true, dereference: true });
  }
  return links.length;
}

// 6. Clean broken symlinks in node_modules
console.log("Cleaning broken symlinks in node_modules...");
const nodeModulesPath = join(piBundle, "node_modules");
if (existsSync(nodeModulesPath)) {
  const nmItems = readdirSync(nodeModulesPath);
  for (const item of nmItems) {
    const fullPath = join(nodeModulesPath, item);
    try {
      if (!existsSync(fullPath)) {
        rmSync(fullPath, { force: true });
        console.log(`Removed broken symlink: ${item}`);
      }
    } catch (e) {
      rmSync(fullPath, { force: true });
    }
  }
}

// 7. Assert every runtime dependency is present
console.log("Verifying runtime dependency manifest against node_modules...");
const runtimeDeps = readRuntimeDeps(join(piBundle, "packages", "coding-agent", "dist"));
const missing = Object.keys(runtimeDeps).filter(
  (dep) => !existsSync(join(piBundle, "node_modules", dep))
);
if (missing.length > 0) {
  console.error(
    `pi-bundle is missing ${missing.length} runtime dependencies declared in runtime-deps.json:\n  ${missing.join(", ")}\n` +
      `The bundled cli.js will fail at runtime with ERR_MODULE_NOT_FOUND.`
  );
  process.exit(1);
}
console.log(`All ${Object.keys(runtimeDeps).length} runtime dependencies present.`);

// 8. v0.9.7 需求1 T1：压成单文件 pi-runtime.zip（NSIS 解 2 万文件 → 解 1 个 zip；
//    首启由 Rust ensure_agent_runtime 解压安装）。
//
//    需求1 反馈（2026-11-12 用户实测：包 58MB→113MB）：pi 上游 v1.5.0 触发
//    全量重打包后，pi-bundle 是 workspace 全仓库形态——node_modules 含全部
//    16 个子包的 hoisted 依赖（158MB，runtime 清单仅 28 项）、packages/ 与
//    node_modules/@earendil-works/* 是同一批实体的两份拷贝。zip 改**白名单**
//    打包（pi-bundle 目录不动——增量守卫照旧）：
//    - bin/（内嵌 node）
//    - node_modules/<runtime-deps 闭包>（直接清单 + BFS 传递/peer 依赖）
//    - node_modules/@earendil-works/*（workspace 实体——subagent 散模块
//      import 走这里）
//    - packages/coding-agent/dist（bundle 入口按此路径启动）+ fixShebang 后
//    - packages/ai/dist/providers/data（模型数据，构建守卫同款路径）
//    - package.json（workspace 元数据，兜底解析）
const piRuntimeZip = resolve(root, "third_party", "pi-runtime.zip");

// 闭包起点：runtime-deps 直接清单 ∪ @earendil-works/*（实体包自身的依赖同样 hoisted）。
// 排除 @earendil-works/pi-coding-agent 实体：全源码树仅 examples/ 引用它
//（运行时入口=packages/coding-agent/dist/bundle 路径，subagent 散模块只
// import pi-tui/pi-ai/pi-agent-core/pi-mcp/pi-codemode——import 统计为据）；
// 与 packages/coding-agent 同一份 28.6MB，打 zip 一次即可。
const closureSeeds = new Set(Object.keys(runtimeDeps));
const nmDir = join(piBundle, "node_modules");
for (const scope of ["@earendil-works"]) {
  const scopeDir = join(nmDir, scope);
  if (!existsSync(scopeDir)) continue;
  for (const pkg of readdirSync(scopeDir)) {
    if (scope === "@earendil-works" && pkg === "pi-coding-agent") continue;
    closureSeeds.add(`${scope}/${pkg}`);
  }
}

// BFS 传递闭包（dependencies + optionalDependencies + peerDependencies——
// hoisted 布局下都在 node_modules 顶层；宁多勿漏：漏 = 运行时
// ERR_MODULE_NOT_FOUND（历史空包事故教训），多 = 体积小损）。
const keepPackages = new Set();
const queue = [...closureSeeds];
while (queue.length > 0) {
  const name = queue.pop();
  if (keepPackages.has(name)) continue;
  const pkgJson = join(nmDir, name, "package.json");
  if (!existsSync(pkgJson)) continue; // 清单声明但未安装（verify 步骤已拦必需项）
  keepPackages.add(name);
  let deps = {};
  try {
    deps = JSON.parse(readFileSync(pkgJson, "utf-8"));
  } catch {
    continue;
  }
  for (const dep of [
    ...Object.keys(deps.dependencies ?? {}),
    ...Object.keys(deps.optionalDependencies ?? {}),
    ...Object.keys(deps.peerDependencies ?? {}),
  ]) {
    if (!keepPackages.has(dep)) queue.push(dep);
  }
}
console.log(`Runtime closure: ${keepPackages.size} packages (from ${closureSeeds.size} seeds + transitive).`);

console.log("Packing pi-runtime.zip...");
await packRuntimeZip(piBundle, piRuntimeZip, keepPackages);
console.log(`pi-runtime.zip ready: ${statSync(piRuntimeZip).size} bytes`);

console.log("pi-bundle preparation complete!");

// v0.9.7 需求1 T1 + 反馈二轮：pi-bundle → pi-runtime.zip（**store 级=纯容器**）。
// 失败必须大声失败（同 runStep 纪律）。
// 压缩分工（实测数据）：zip 分文件 deflate 对同一内容 79.7MB，NSIS lzma
// 固体压缩 43.0MB——zip 预压会让 NSIS 对已压数据几乎无收益（安装包 91.7MB
// 的主因）。故 zip 只做容器（store，首启解压=纯拷贝更快），压缩完全交给
// NSIS lzma（0.9.6 直排时代同款管线，包体回到 ~60MB 水平）。
async function packRuntimeZip(bundleDir, zipPath, keepPackages) {
  if (existsSync(zipPath)) rmSync(zipPath, { force: true });
  const output = createWriteStream(zipPath);
  const archive = archiver("zip", { store: true });
  const fail = new Promise((_, reject) => {
    output.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(output);
  // 白名单 glob 集（根目录逐项打包；dot: true 保 hidden 项）。
  const patterns = [
    "bin/**",
    "package.json",
    "packages/coding-agent/dist/**",
    "packages/ai/dist/providers/data/**",
    ...[...keepPackages].map((p) => `node_modules/${p}/**`),
  ];
  for (const pattern of patterns) {
    archive.glob(pattern, { cwd: bundleDir, dot: true });
  }
  const done = new Promise((resolveDone, reject) => {
    output.on("close", resolveDone);
    output.on("error", reject);
  });
  await archive.finalize();
  await Promise.race([done, fail]);
}
