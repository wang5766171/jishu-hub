import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
const newVersion = args[0];

if (!newVersion) {
  console.error("Usage: node scripts/upgrade-version.mjs <new_version>");
  console.error("Example: node scripts/upgrade-version.mjs 0.78.1-2");
  process.exit(1);
}

const ROOT_DIR = path.resolve(process.cwd(), "third_party", "pi");
const PACKAGES_DIR = path.join(ROOT_DIR, "packages");

console.log(`🚀 Upgrading Jishu Agent to version: ${newVersion}\n`);

// 1. Create Git branch
console.log(`[1] Creating new git branch in third_party/pi...`);
try {
  execSync(`git checkout -b release_v${newVersion}`, { cwd: ROOT_DIR, stdio: "inherit" });
} catch (e) {
  console.log(`⚠️ Branch creation failed (maybe it already exists?), continuing...`);
}

// 2. Update package.jsons
console.log(`\n[2] Updating package.json versions...`);
const pkgsToUpdate = [
  "package.json",
  "packages/agent/package.json",
  "packages/ai/package.json",
  "packages/coding-agent/package.json",
  "packages/tui/package.json",
  "packages/server/package.json",
];

for (const pkgPath of pkgsToUpdate) {
  const fullPath = path.join(ROOT_DIR, pkgPath);
  if (fs.existsSync(fullPath)) {
    const json = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    const oldVersion = json.version;
    json.version = newVersion;
    
    // Also update cross-dependencies within the workspace
    const internalDeps = [
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-tui",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-server",
    ];
    for (const depType of ["dependencies", "devDependencies", "peerDependencies"]) {
      if (json[depType]) {
        for (const [dep, ver] of Object.entries(json[depType])) {
          if (internalDeps.includes(dep)) {
            json[depType][dep] = newVersion;
          }
        }
      }
    }

    fs.writeFileSync(fullPath, JSON.stringify(json, null, "\t") + "\n");
    console.log(`  - Updated ${pkgPath} (from ${oldVersion} to ${newVersion})`);
  }
}

// 3. Update NPM Lockfile
console.log(`\n[3] Running npm install to sync the root package-lock.json...`);
try {
  execSync("npm install", { cwd: ROOT_DIR, stdio: "inherit" });
} catch (e) {
  console.error("❌ npm install failed");
  process.exit(1);
}

// 3.5 Regenerate coding-agent npm-shrinkwrap.json
// `npm install` above only syncs the root package-lock.json. It does NOT touch
// packages/coding-agent/npm-shrinkwrap.json — that is a separate file regenerated from
// coding-agent/package.json + the root lock by generate-coding-agent-shrinkwrap.mjs.
// Without this step the shrinkwrap keeps the OLD version while package.json moves ahead.
// npm-shrinkwrap overrides package.json at install time, so a stale shrinkwrap makes the
// published Lite package resolve its internal deps (@earendil-works/pi-*) to the
// nonexistent previous version (404 / ERR_MODULE_NOT_FOUND). Regenerate it in lockstep.
console.log(`\n[3.5] Regenerating packages/coding-agent/npm-shrinkwrap.json...`);
try {
  execSync("npm run shrinkwrap:coding-agent", { cwd: ROOT_DIR, stdio: "inherit" });
} catch (e) {
  console.error("❌ Failed to regenerate coding-agent npm-shrinkwrap.json");
  process.exit(1);
}

// 3.6 Regenerate coding-agent install-lock
console.log(`\n[3.6] Regenerating packages/coding-agent/install-lock...`);
try {
  execSync("npm run install-lock:coding-agent", { cwd: ROOT_DIR, stdio: "inherit" });
} catch (e) {
  console.error("❌ Failed to regenerate coding-agent install-lock");
  process.exit(1);
}

// 4. Update Jishu Hub Backend Binding
console.log(`\n[4] Binding Jishu Hub Lite to Jishu Agent @${newVersion}...`);
const libRsPath = path.resolve(process.cwd(), "src-tauri", "src", "lib.rs");
if (fs.existsSync(libRsPath)) {
  let content = fs.readFileSync(libRsPath, "utf-8");
  // Regex to match the binding section exactly
  // Format-agnostic: match from the START marker through @jishu-hub/jishu-agent@<version>"
  // up to the END marker, so rustfmt's multi-line `vec![...]` layout (each element on its
  // own line, `],` / `);` on separate lines) matches just as well as the old single-line form.
  const regex = /(\/\/ JISHU_AGENT_BINDING_START[\s\S]*?@jishu-hub\/jishu-agent@)[^"]+("[\s\S]*?\/\/ JISHU_AGENT_BINDING_END)/;
  
  const match = content.match(regex);
  if (match) {
    content = content.replace(regex, `$1${newVersion}$2`);
    fs.writeFileSync(libRsPath, content);
    console.log(`  - Successfully updated src-tauri/src/lib.rs`);
  } else {
    console.warn(`  ⚠️ Could not find binding marker in lib.rs. Please update it manually.`);
  }
}

// 4.5 Update Jishu Agent Version Constant
console.log(`\n[4.5] Updating Jishu Agent Version constant in Rust...`);
const modRsPath = path.resolve(process.cwd(), "src-tauri", "src", "agent", "jishu_self", "mod.rs");
if (fs.existsSync(modRsPath)) {
  let content = fs.readFileSync(modRsPath, "utf-8");
  const regex = /(\/\/\s*JISHU_AGENT_VERSION_START[\s\S]*?pub const PI_AGENT_VERSION:\s*&str\s*=\s*")[^"]+("\s*;[\s\S]*?\/\/\s*JISHU_AGENT_VERSION_END)/m;
  const match = content.match(regex);
  if (match) {
    content = content.replace(regex, `$1${newVersion}$2`);
    fs.writeFileSync(modRsPath, content);
    console.log(`  - Successfully updated src-tauri/src/agent/jishu_self/mod.rs`);
  } else {
    console.warn(`  ⚠️ Could not find PI_AGENT_VERSION marker in mod.rs. Please update it manually.`);
  }
}

// 5. Update only the current Pi maintenance branch references.
console.log(`\n[5] Updating current Pi branch references...`);
const piChangePath = path.resolve(process.cwd(), "PI_CHANGE.MD");
if (fs.existsSync(piChangePath)) {
  let content = fs.readFileSync(piChangePath, "utf-8");
  content = content.replace(
    /(\| 当前维护分支 \| `)release_v[^`]+(` \|)/,
    `$1release_v${newVersion}$2`,
  );
  content = content.replace(
    /(\| `\.gitmodules` branch \| `)release_v[^`]+(` \|)/,
    `$1release_v${newVersion}$2`,
  );
  fs.writeFileSync(piChangePath, content);
  console.log(`  - Updated current branch fields in PI_CHANGE.MD`);
}

const gitmodulesPath = path.resolve(process.cwd(), ".gitmodules");
if (fs.existsSync(gitmodulesPath)) {
  let content = fs.readFileSync(gitmodulesPath, "utf-8");
  content = content.replace(
    /(submodule "third_party\/pi"\][\s\S]*?\bbranch\s*=\s*)[^\r\n]+/,
    `$1release_v${newVersion}`,
  );
  fs.writeFileSync(gitmodulesPath, content);
  console.log(`  - Updated .gitmodules branch`);
}

console.log(`\n✅ Upgrade Complete!`);
console.log(`=============================================`);
console.log(`Next Steps:`);
console.log(`1. Review the changes in git (both jishu-hub and third_party/pi)`);
console.log(`2. Commit the changes in third_party/pi:`);
console.log(`   cd third_party/pi`);
console.log(`   git commit -am "chore: bump version to ${newVersion}"`);
console.log(`   git push -u origin release_v${newVersion}`);
console.log(`3. Commit the changes in jishu-hub:`);
console.log(`   cd ../..`);
console.log(`   git commit -am "chore: upgrade jishu-agent binding to ${newVersion}"`);
console.log(`4. Run the publish script to push to NPM:`);
console.log(`   node scripts/publish-pi.mjs --scope @jishu-hub`);
console.log(`=============================================\n`);
