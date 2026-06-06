import { spawnSync } from "node:child_process";
import { writeFileSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 1. Build pi_agent_rust runtime
const piAgentRustDir = resolve(root, "third_party", "pi_agent_rust");
if (existsSync(piAgentRustDir)) {
  const cargoBuild = spawnSync("cargo", ["build", "--release", "--bin", "pi"], { cwd: piAgentRustDir, stdio: "inherit", shell: process.platform === "win32" });
  if (cargoBuild.status !== 0) process.exit(cargoBuild.status ?? 1);
  const source = resolve(piAgentRustDir, "target", "release", "pi.exe");
  const target = resolve(root, "src-tauri", "bin", "pi-x86_64-pc-windows-msvc.exe");
  copyFileSync(source, target);
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
