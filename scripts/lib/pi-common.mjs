import fs from "node:fs";
import path from "node:path";

const SHEBANG = "#!/usr/bin/env node\n";

/**
 * Normalize shebangs on the esbuild entry points inside `distDir`.
 *
 * build-bundle.mjs configures esbuild with a `banner` that injects a shebang
 * into every entry point. src/cli.ts ALSO carries its own source-level shebang,
 * so dist/cli.js ends up with two stacked shebang lines — and Node throws a
 * SyntaxError on the second line when the file is executed.
 *
 * This collapses any number of stacked leading shebangs deterministically:
 * the executable entries (cli.js and rpc-entry.js) keep exactly one, while
 * the library entry (index.js) keeps none.
 *
 * @param {string} distDir - the dist/ directory containing bundled entry points
 */
export function fixShebang(distDir) {
  for (const [entry, keepShebang] of [
    ["cli.js", true],
    ["rpc-entry.js", true],
    ["index.js", false],
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
 * dependencies the bundled cli.js requires at runtime. pack-pi.mjs (Full)
 * asserts these are present in node_modules; publish-pi.mjs (Lite) declares
 * them in the published package.json. Deriving both from the same file is what
 * keeps the two packaging paths from drifting.
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
