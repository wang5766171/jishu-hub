/**
 * kill-port.mjs — Ensure port 1420 is fully available before Vite starts.
 *
 * Root cause of the white screen: On Windows, after stopping `npm run tauri dev`,
 * TCP connections on port 1420 linger in TIME_WAIT state (PID 0) for up to
 * 4 minutes. Vite's `strictPort: true` refuses to bind when any socket holds
 * the port, causing Vite to exit immediately. Tauri then opens a window
 * pointing at http://localhost:1420 which has nothing listening → white screen.
 *
 * Solution:
 *   1. Kill any real process (PID ≠ 0) on port 1420.
 *   2. Poll-try to bind a test TCP server to 127.0.0.1:1420.
 *      Once the bind succeeds, close the test server and exit.
 *   3. If the port doesn't free within 30s, warn and proceed anyway.
 */

import { execSync } from "child_process";
import { createServer } from "net";

const PORT = 1420;
const MAX_WAIT_MS = 30_000;
const POLL_MS = 1000;

// ── Step 1: Kill real processes ────────────────────────────────────────
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
      console.log(`[kill-port] Killing PID ${pid} on port ${PORT}`);
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      } catch { /* already gone */ }
    }
    if (pids.size > 0) {
      console.log(`[kill-port] Killed ${pids.size} process(es)`);
    }
  } catch { /* no processes found */ }
}

// ── Step 2: Wait for the port to be bindable ───────────────────────────
function tryBind() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port: PORT, host: "127.0.0.1", exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function waitForPort() {
  const deadline = Date.now() + MAX_WAIT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    if (await tryBind()) {
      if (attempt > 1) {
        console.log(`[kill-port] Port ${PORT} freed after ${attempt} attempts`);
      }
      return true;
    }
    if (attempt === 1) {
      console.log(
        `[kill-port] Port ${PORT} still held (TIME_WAIT), waiting up to ${MAX_WAIT_MS / 1000}s...`
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

// ── Main ───────────────────────────────────────────────────────────────
killProcessesOnPort();
const ok = await waitForPort();
if (ok) {
  console.log(`[kill-port] ✓ Port ${PORT} is ready`);
} else {
  console.warn(
    `[kill-port] ⚠ Port ${PORT} still unavailable after ${MAX_WAIT_MS / 1000}s. Vite may fail.`
  );
}
