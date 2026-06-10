import { spawnSync } from "node:child_process";
import { writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const isLite = process.argv.includes("--lite");

// 1. Build third_party/pi (Native Node Agent)
const piRoot = resolve(root, "third_party", "pi");
if (!isLite && existsSync(piRoot)) {
  console.log("Building bundled pi agent...");
  spawnSync("npm", ["install"], { cwd: piRoot, stdio: "inherit", shell: true });
  spawnSync("npm", ["run", "build"], { cwd: piRoot, stdio: "inherit", shell: true });
  console.log("Pruning dev dependencies to reduce installer size...");
  spawnSync("npm", ["prune", "--omit=dev"], { cwd: piRoot, stdio: "inherit", shell: true });
} else if (isLite) {
  console.log("Lite mode enabled. Skipping bundled pi agent build.");
}

const steps = [
  ["node", ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.app.json", "--noEmit", "--incremental", "false"]],
  ["node", ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.node.json", "--noEmit", "--incremental", "false"]],
  ["node", ["./node_modules/vite/bin/vite.js", "build"]],
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// For macOS/Linux Tauri externalBin support, create a dummy file to satisfy tauri_build, then overwrite it
const rustInfo = spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout;
const targetTripleMatch = rustInfo.match(/host: (.+)/);
let sidecarTarget = null;
let sidecarName = null;

if (targetTripleMatch) {
  const targetTriple = targetTripleMatch[1].trim();
  sidecarName = process.platform === "win32" ? `jishu-${targetTriple}.exe` : `jishu-${targetTriple}`;
  sidecarTarget = resolve(root, "src-tauri", "target", "release", sidecarName);
  
  // Ensure directory exists and write a dummy file to satisfy build.rs externalBin check
  mkdirSync(resolve(root, "src-tauri", "target", "release"), { recursive: true });
  if (!existsSync(sidecarTarget)) {
    writeFileSync(sidecarTarget, "");
  }
}

// Build the CLI binary
const cliBuild = spawnSync("cargo", ["build", "--release", "--bin", "jishu", "--features", "cli", "--manifest-path", "src-tauri/Cargo.toml"], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});

if (cliBuild.status !== 0) {
  process.exit(cliBuild.status ?? 1);
}

const cliName = process.platform === "win32" ? "jishu.exe" : "jishu";
const cliSource = resolve(root, "src-tauri", "target", "release", cliName);
const nsisCliSource = resolve(root, "src-tauri", "nsis", "cli-source.nsh");

writeFileSync(nsisCliSource, `!define JISHU_CLI_SOURCE "${cliSource}"\n`);

if (sidecarTarget) {
  copyFileSync(cliSource, sidecarTarget);
  console.log(`Copied sidecar for externalBin: ${sidecarName}`);
}


// ---------------------------------------------------------
// 2. Run Tauri Build
// ---------------------------------------------------------
console.log("Running tauri build...");
import { readdirSync, renameSync } from "node:fs";

const tauriArgs = isLite 
  ? ["run", "tauri", "build", "--config", "src-tauri/tauri.conf.lite.json"] 
  : ["run", "tauri", "build"];

const tauriBuild = spawnSync("npm", tauriArgs, {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

if (tauriBuild.status !== 0) {
  process.exit(tauriBuild.status ?? 1);
}

// ---------------------------------------------------------
// 3. Post-build Rename
// ---------------------------------------------------------
const nsisDir = resolve(root, "src-tauri", "target", "release", "bundle", "nsis");
if (existsSync(nsisDir)) {
  const files = readdirSync(nsisDir);
  for (const file of files) {
    if (file.startsWith("Jishu Hub_") && file.endsWith("-setup.exe")) {
      const newName = isLite 
        ? file.replace("Jishu Hub_", "Jishu Hub Lite_")
        : file.replace("Jishu Hub_", "Jishu Hub Full_");
      renameSync(resolve(nsisDir, file), resolve(nsisDir, newName));
      console.log(`Renamed installer to: ${newName}`);
    }
  }
}

