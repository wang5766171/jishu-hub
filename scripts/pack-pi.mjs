import { spawnSync } from "node:child_process";
import { cpSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { fixShebang, readRuntimeDeps } from "./lib/pi-common.mjs";

const root = resolve(process.cwd());
const piRoot = resolve(root, "third_party", "pi");
const piBundle = resolve(root, "third_party", "pi-bundle");

console.log("Preparing pi-bundle...");

// 1. Remove old pi-bundle
if (existsSync(piBundle)) {
  rmSync(piBundle, { recursive: true, force: true });
}

// 2. Copy pi to pi-bundle, excluding node_modules, .git, and dist to start fresh
cpSync(piRoot, piBundle, {
  recursive: true,
  filter: (src) => {
    const name = src.split(/[\\/]/).pop();
    if (['node_modules', '.git', 'dist', '.github', '.husky'].includes(name)) return false;
    return true;
  }
});

// 3. Install dependencies in pi-bundle.
// --ignore-scripts: 跳过 native 模块的 postinstall（如 canvas 的 node-gyp，
// Windows 缺 cairo 会失败并中断整个 install，导致排在后面的 @typescript/native-preview
// 没装上、tsgo 缺失、build 失败）。pi/ai 不实际 import canvas，跳过其 gyp 无害；
// tsgo(@typescript/native-preview) 的二进制经 optionalDependencies 预编译提供，不受影响。
console.log("Installing dependencies in pi-bundle...");
spawnSync("npm", ["install", "--ignore-scripts"], { cwd: piBundle, stdio: "inherit", shell: true });

// 4. Build the project
console.log("Building pi-bundle...");
spawnSync("npm", ["run", "build"], { cwd: piBundle, stdio: "inherit", shell: true });

// 5. Prune dev dependencies
console.log("Pruning dev dependencies...");
spawnSync("npm", ["prune", "--omit=dev"], { cwd: piBundle, stdio: "inherit", shell: true });

// 6. Clean up source files to obfuscate and reduce size
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

// 6.5 Fix double shebang in entry points (shared implementation in scripts/lib/pi-common.mjs)
console.log("Fixing double shebangs...");
fixShebang(join(piBundle, "packages", "coding-agent", "dist"));

// 6.6 Embed portable Node.js runtime (v0.8.1 需求10 修复：新机器无 Node 时
// jishu-self 报未安装/无法对话——pi-bundle 此前只含 JS 代码，node.exe 依赖
// 用户 PATH。把当前构建机的 node 复制到 pi-bundle/bin/，安装时随 pi-bundle
// 落到 ~/.jishu-agent/bin/，resolve_pi_runtime 优先使用）。
const nodeBinDir = join(piBundle, "bin");
const nodeBinaryName = process.platform === "win32" ? "node.exe" : "node";
const nodeSource = process.execPath; // 当前运行的 node 可执行文件路径
if (existsSync(nodeSource)) {
  if (!existsSync(nodeBinDir)) {
    cpSync(nodeSource, join(nodeBinDir, nodeBinaryName));
    console.log(`Embedded portable node: ${nodeSource} → ${nodeBinDir}/${nodeBinaryName}`);
  }
} else {
  console.warn(`WARNING: cannot find node binary at ${nodeSource} to embed.`);
}

// 7. Clean broken symlinks in node_modules
console.log("Cleaning broken symlinks in node_modules...");
const nodeModulesPath = join(piBundle, "node_modules");
if (existsSync(nodeModulesPath)) {
  const nmItems = readdirSync(nodeModulesPath);
  for (const item of nmItems) {
    const fullPath = join(nodeModulesPath, item);
    try {
      if (!existsSync(fullPath)) {
        // existsSync returns false for broken symlinks
        rmSync(fullPath, { force: true });
        console.log(`Removed broken symlink: ${item}`);
      }
    } catch (e) {
      rmSync(fullPath, { force: true });
    }
  }
}

// 8. Assert every runtime dependency in build-bundle's manifest is physically
// present in pi-bundle's node_modules. The manifest is the single source of
// truth for which runtime deps the bundled cli.js needs. Full satisfies it by
// baking the deps in locally. This guard fails the build loudly if a runtime
// dep is missing — the exact failure (ERR_MODULE_NOT_FOUND) that was previously
// silently masked by the workspace over-install.
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
