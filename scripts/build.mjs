import { spawnSync } from "node:child_process";
import { writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const isLite = process.argv.includes("--lite");

// 1. Build third_party/pi (Native Node Agent)
const piRoot = resolve(root, "third_party", "pi");
const isNestedBuild = !!process.env.IS_BUILD_MJS;

if (!isLite && existsSync(piRoot) && !isNestedBuild) {
  console.log("Building bundled pi agent via pack-pi.mjs...");
  spawnSync("node", ["./scripts/pack-pi.mjs"], { cwd: root, stdio: "inherit", shell: false });
} else if (isLite || isNestedBuild) {
  console.log("Skipping bundled pi agent build (Lite mode or nested build).");
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
  sidecarName = process.platform === "win32" ? `jishu-cli-${targetTriple}.exe` : `jishu-cli-${targetTriple}`;
  sidecarTarget = resolve(root, "src-tauri", "target", "release", sidecarName);
  
  // Ensure directory exists and write a dummy file to satisfy build.rs externalBin check
  mkdirSync(resolve(root, "src-tauri", "target", "release"), { recursive: true });
  if (!existsSync(sidecarTarget)) {
    writeFileSync(sidecarTarget, "");
  }
}

// Build the CLI binary
const cliBuild = spawnSync("cargo", ["build", "--release", "--bin", "jishu-cli", "--features", "cli", "--manifest-path", "src-tauri/Cargo.toml"], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});

if (cliBuild.status !== 0) {
  process.exit(cliBuild.status ?? 1);
}

const cliName = process.platform === "win32" ? "jishu-cli.exe" : "jishu-cli";
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
if (!process.env.IS_BUILD_MJS) {
  console.log("Running tauri build...");
  const tauriArgs = isLite 
    ? ["run", "tauri", "build", "--", "--config", "src-tauri/tauri.conf.lite.json"] 
    : ["run", "tauri", "build"];

  const tauriBuild = spawnSync("npm", tauriArgs, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, IS_BUILD_MJS: "1" }
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
        
        let retries = 5;
        while (retries > 0) {
          try {
            renameSync(resolve(nsisDir, file), resolve(nsisDir, newName));
            console.log(`Renamed installer to: ${newName}`);
            break;
          } catch (e) {
            if (e.code === 'EPERM' || e.code === 'EBUSY') {
              console.log(`Failed to rename, retrying in 2 seconds... (${retries} attempts left)`);
              spawnSync("node", ["-e", "setTimeout(() => {}, 2000)"]); // simple wait
              retries--;
              if (retries === 0) throw e;
            } else {
              throw e;
            }
          }
        }
      }
    }
  }
} else {
  console.log("Skipping nested tauri build...");
}

