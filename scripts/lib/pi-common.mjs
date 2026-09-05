import fs from "node:fs";
import path from "node:path";

const SHEBANG = "#!/usr/bin/env node\n";

/**
 * Normalize shebangs on the bundled entry points inside `distDir`.
 *
 * v0.85.0 起 pi 的 CLI 产物切换到上游 build-coding-agent-bundle.mjs 的
 * dist/bundle/ 布局（cli/rpc-entry/coordinator 在 dist/bundle/，库入口
 * dist/index.js 与 bundle/index.js 并存）；旧布局（dist/cli.js）在存量
 * 安装中仍存在，两处都处理，找不到的文件静默跳过。
 *
 * Executable entries (cli.js and rpc-entry.js) keep exactly one shebang,
 * while the library entries (index.js) keep none.
 *
 * @param {string} distDir - the dist/ directory containing bundled entry points
 */
export function fixShebang(distDir) {
  for (const [entry, keepShebang] of [
    ["bundle/cli.js", true],
    ["bundle/rpc-entry.js", true],
    ["cli.js", true],
    ["rpc-entry.js", true],
    ["index.js", false],
    ["bundle/index.js", false],
  ]) {
    const entryPath = path.join(distDir, entry);
    if (!fs.existsSync(entryPath)) continue;
    let content = fs.readFileSync(entryPath, "utf8");
    let changed = false;
    while (content.startsWith(SHEBANG)) {
      content = content.slice(SHEBANG.length);
      changed = true;
    }
    if (keepShebang) {
      content = SHEBANG + content;
      changed = true;
    }
    if (changed) fs.writeFileSync(entryPath, content);
  }
}

/**
 * Read the runtime dependency manifest emitted by build-bundle.mjs.
 *
 * This manifest is the single source of truth for which non-@earendil-works
 * dependencies the bundled cli.js requires at runtime. pack-pi.mjs asserts
 * these are present in node_modules, failing the build loudly if any runtime
 * dep is missing.
 *
 * @param {string} distDir - the dist/ directory containing runtime-deps.json
 * @returns {Record<string, string>} map of dependency name -> version
 */
export function readRuntimeDeps(distDir) {
  const manifestPath = path.join(distDir, "runtime-deps.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `runtime-deps.json not found at ${manifestPath}. ` +
        `Run the coding-agent build (npm run build), which runs build-bundle.mjs, to generate it.`
    );
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}
