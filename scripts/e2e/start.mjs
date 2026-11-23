#!/usr/bin/env node
/**
 * start.mjs —— 带调试口启动 jishu-hub（供 run.mjs 附着）。仅 Windows。
 *
 * 用法（仓库根目录）：
 *   node scripts/e2e/start.mjs                     启动（自动找应用：仓库构建 / 安装目录，取最新）
 *   node scripts/e2e/start.mjs --exe <路径>         指定 jishu-hub.exe
 *   node scripts/e2e/start.mjs --restart            应用已在运行但没开调试口时，自动重启（有会话正在写入则拒绝）
 *   node scripts/e2e/start.mjs --port 9222          调试口（默认 9222）
 *   node scripts/e2e/start.mjs --stop               关闭应用（测试结束后，再按平时方式打开即无调试口）
 *
 * 应用路径查找顺序：--exe > 环境变量 JISHU_HUB_EXE > 候选里修改时间最新的一个
 *（仓库 src-tauri/target/release 构建、注册表登记的安装目录、常见安装目录）。
 *
 * 退出码：0 = 调试口就绪；1 = 启动失败；2 = 参数/路径问题；3 = 应用在运行且没开调试口
 *（未给 --restart）或有会话正在写入；4 = 非 Windows。开发模式（npm run tauri dev）
 * 请自行带环境变量启动：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run tauri dev
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPowerShell } from "./lib-pw.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

const cdpUp = async (port) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 注册表路径用 String.raw：普通字符串里 \S \M 这类反斜杠会被当成转义符吃掉
const UNINSTALL_KEYS = String.raw`'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'`;

/** 注册表登记的安装目录（NSIS 卸载项）。 */
async function installDirFromRegistry() {
  const out = await runPowerShell(
    `Get-ItemProperty ${UNINSTALL_KEYS} -ErrorAction SilentlyContinue | ` +
      "Where-Object { $_.DisplayName -like 'Jishu Hub*' -and $_.InstallLocation } | ForEach-Object { $_.InstallLocation.Trim('\"') } | Select-Object -First 1",
  ).catch(() => "");
  const dir = (out || "").split("\n")[0].trim().replace(/"/g, "");
  return dir ? path.join(dir, "jishu-hub.exe") : null;
}

/** 候选应用路径里实际存在的（未去重、未排序）。 */
async function findExe(explicit) {
  if (explicit) return fs.existsSync(explicit) ? [explicit] : [];
  const candidates = [
    process.env.JISHU_HUB_EXE,
    path.join(ROOT, "src-tauri", "target", "release", "jishu-hub.exe"),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Jishu Hub", "jishu-hub.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Jishu Hub", "jishu-hub.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Jishu Hub", "jishu-hub.exe"),
    await installDirFromRegistry(),
  ].filter(Boolean);
  return [...new Set(candidates)].filter((p) => fs.existsSync(p));
}

async function listHubProcesses() {
  const out = await runPowerShell(
    "Get-CimInstance Win32_Process -Filter \"Name='jishu-hub.exe'\" | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ExecutablePath, $_.CreationDate }",
  ).catch(() => "");
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [pid, exe, started] = l.split("|");
      return { pid: Number(pid), exe, started };
    });
}

/** 近 ms 毫秒内有写入的会话文件数（>0 说明有回合在跑）。 */
function recentSessionWrites(ms) {
  const root = process.env.JISHU_AGENT_SESSIONS_DIR || path.join(os.homedir(), ".jishu-agent", "agent", "sessions");
  if (!fs.existsSync(root)) return 0;
  const since = Date.now() - ms;
  let n = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl") && fs.statSync(p).mtimeMs >= since) n++;
    }
  })(root);
  return n;
}

async function main() {
  if (process.platform !== "win32") {
    console.error("start.mjs 仅支持 Windows（依赖 WebView2 的远程调试口）。");
    return 4;
  }
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || 9222);

  if (args.stop) {
    const procs = await listHubProcesses();
    for (const p of procs) await new Promise((resolve) => execFile("taskkill", ["/PID", String(p.pid), "/F"], () => resolve()));
    console.log(procs.length ? `已关闭应用（${procs.length} 个进程）。` : "应用未在运行。");
    return 0;
  }

  if (await cdpUp(port)) {
    console.log(`调试口已就绪：http://127.0.0.1:${port}`);
    return 0;
  }

  const running = await listHubProcesses();
  if (running.length) {
    if (!args.restart) {
      console.error(`应用已在运行，但没开调试口（单实例——再启动一个只会聚焦它）：`);
      for (const p of running) console.error(`  PID ${p.pid}  ${p.exe}  启动于 ${p.started}`);
      console.error(`加 --restart 让我重启它（有会话正在写入时会拒绝）。`);
      return 3;
    }
    const active = recentSessionWrites(20000);
    if (active > 0) {
      console.error(`有会话文件正在写入（近 20 秒 ${active} 个）——像是还有回合在跑，不动它。等它结束再试。`);
      return 3;
    }
    for (const p of running) {
      await new Promise((resolve) => execFile("taskkill", ["/PID", String(p.pid), "/F"], () => resolve()));
      console.log(`已关闭运行中的应用（PID ${p.pid}，${p.exe}）。`);
    }
    await sleep(800);
    // 旧 WebView2 池进程不带调试参数，留着会被复用导致调试口起不来——此时已无应用实例，清理是安全的
    await runPowerShell(
      "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -match 'jishu-hub' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ).catch(() => {});
  }

  if (args.exe && !fs.existsSync(String(args.exe))) {
    console.error(`找不到指定的应用：${args.exe}`);
    return 2;
  }
  const existing = await findExe(args.exe ? String(args.exe) : null);
  if (!existing.length) {
    console.error("找不到 jishu-hub.exe。请用 --exe 指定，或先安装/构建应用。");
    return 2;
  }
  existing.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const exe = existing[0];
  const mtime = fs.statSync(exe).mtime.toLocaleString("zh-CN", { hour12: false });
  console.log(`启动：${exe}（构建于 ${mtime}）`);

  const child = spawn(exe, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  });
  child.unref();

  const deadline = Date.now() + Number(args.timeout || 90000);
  while (Date.now() < deadline) {
    if (await cdpUp(port)) {
      console.log(`调试口已就绪：http://127.0.0.1:${port}`);
      return 0;
    }
    await sleep(500);
  }
  console.error(`应用已启动，但 ${Math.round((Number(args.timeout || 90000)) / 1000)} 秒内调试口没有就绪。`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
