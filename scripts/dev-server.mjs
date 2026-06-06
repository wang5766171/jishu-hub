/**
 * dev-server.mjs — Managed Vite startup for Tauri dev mode.
 *
 * Replaces the raw `vite` command with a wrapper that:
 *   1. Runs kill-port.mjs to ensure port 1420 is free
 *   2. Starts Vite via Node API with visible logging
 *   3. Reports startup success/failure clearly
 */

import { execSync, spawn } from "child_process";
import { createServer } from "net";
import { fileURLToPath } from "url";
import path from "path";

const PORT = 1420;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ── Step 1: Kill existing processes on the port ────────────────────────
function killProcessesOnPort() {
  try {
    const output = execSync(`netstat -ano | findstr :${PORT}`, {
      encoding: "utf-8",
    });
    const pids = new Set();
    for (const line of output.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length > 4 && parts[1].includes(`:${PORT}`)) {
        const pid = parts[parts.length - 1];
        if (pid !== "0") pids.add(pid);
      }
    }
    for (const pid of pids) {
      console.log(`[dev-server] Killing PID ${pid} on port ${PORT}`);
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      } catch { /* already gone */ }
    }
    if (pids.size === 0) {
      console.log(`[dev-server] No processes found on port ${PORT}`);
    }
  } catch {
    console.log(`[dev-server] Port ${PORT} is clear`);
  }
}

// ── Step 2: Wait for port to be bindable ───────────────────────────────
function tryBind() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port: PORT, host: "127.0.0.1", exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function waitForPort(maxMs = 15000) {
  const deadline = Date.now() + maxMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    if (await tryBind()) {
      return true;
    }
    if (attempt === 1) {
      console.log(`[dev-server] Waiting for port ${PORT} to clear...`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ── Step 3: Start Vite ─────────────────────────────────────────────────
async function main() {
  console.log(`[dev-server] Preparing port ${PORT}...`);
  killProcessesOnPort();

  const portOk = await waitForPort();
  if (!portOk) {
    console.error(`[dev-server] ERROR: Port ${PORT} is still in use after 15s`);
    console.error(`[dev-server] Try closing other apps or wait a moment, then retry`);
    process.exit(1);
  }
  console.log(`[dev-server] Port ${PORT} is available, starting Vite...`);

  // Spawn vite as a child process so its output is visible
  const child = spawn("npx vite", {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
    env: { ...process.env },
  });

  child.on("error", (err) => {
    console.error(`[dev-server] Failed to start Vite: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    console.log(`[dev-server] Vite exited with code ${code}`);
    process.exit(code ?? 1);
  });

  // Forward kill signals
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      child.kill(sig);
    });
  }
}

main();
