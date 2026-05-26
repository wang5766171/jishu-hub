import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
