import { spawnSync } from "node:child_process";
import { cpSync, rmSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
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

console.log("pi-bundle preparation complete!");
