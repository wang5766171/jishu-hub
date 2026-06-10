import { spawnSync } from "node:child_process";
import { cpSync, rmSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

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

// 3. Install dependencies in pi-bundle
console.log("Installing dependencies in pi-bundle...");
spawnSync("npm", ["install"], { cwd: piBundle, stdio: "inherit", shell: true });

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

// 6.5 Fix double shebang in entry points
console.log("Fixing double shebangs...");
const cliJsPath = join(piBundle, "packages", "coding-agent", "dist", "cli.js");
if (existsSync(cliJsPath)) {
  let content = readFileSync(cliJsPath, "utf8");
  if (content.startsWith("#!/usr/bin/env node\n#!/usr/bin/env node\n")) {
    content = content.replace(/^#!\/usr\/bin\/env node\n#!\/usr\/bin\/env node\n/, "#!/usr/bin/env node\n");
    writeFileSync(cliJsPath, content);
  }
}
const indexJsPath = join(piBundle, "packages", "coding-agent", "dist", "index.js");
if (existsSync(indexJsPath)) {
  let content = readFileSync(indexJsPath, "utf8");
  if (content.startsWith("#!/usr/bin/env node\n#!/usr/bin/env node\n")) {
    content = content.replace(/^#!\/usr\/bin\/env node\n#!\/usr\/bin\/env node\n/, "#!/usr/bin/env node\n");
    writeFileSync(indexJsPath, content);
  } else if (content.startsWith("#!/usr/bin/env node\n")) {
    content = content.replace(/^#!\/usr\/bin\/env node\n/, "");
    writeFileSync(indexJsPath, content);
  }
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

console.log("pi-bundle preparation complete!");
