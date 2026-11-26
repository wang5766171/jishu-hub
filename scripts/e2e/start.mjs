#!/usr/bin/env node
/**
 * start.mjs —— 带调试口启动 jishu-hub（供 run.mjs 附着）。仅 Windows。
 *
 * 用法（仓库根目录）：
 *   node scripts/e2e/start.mjs                     启动（自动找应用：仓库构建 / 安装目录，取最新）
 *   node scripts/e2e/start.mjs --exe <路径>         指定 jishu-hub.exe
 *   node scripts/e2e/start.mjs --restart            应用已在运行但没开调试口时，自动重启（有会话正在写入则拒绝）
 *   node scripts/e2e/start.mjs --port 9222          调试口（默认 9222）
 *   node scripts/e2e/start.mjs --stop               关闭**本脚本启动的**那个实例（测完再按平时方式打开，即无调试口）
 *   node scripts/e2e/start.mjs --stop --force       近 20 秒有会话文件在写也关（默认这种情况会拒绝）
 *   node scripts/e2e/start.mjs --help               只打印用法，不启动应用
 *
 * 应用路径查找顺序：--exe > 环境变量 JISHU_HUB_EXE > 候选里修改时间最新的一个
 *（仓库 src-tauri/target/release 构建、注册表登记的安装目录、常见安装目录）。
 *
 * 评审修复轮 R2 的三条规矩（E-4）：
 * - `--stop` 只关自己启动的实例：启动时把进程号、路径、端口记在 scripts/e2e/results/.started.json
 *   （results/ 不入库）；按进程树关（taskkill /T，连同它的网页进程和引擎子进程）。没有记录、进程已经
 *   不在、或那个进程号现在不是记录里的那个程序 → 不动任何 jishu-hub 进程。用户自己打开的实例不受影响。
 * - 调试口上不是 jishu-hub 时拒绝附着：端口被别的程序占着（Chrome / Edge / 别的 Tauri 应用）→ 报错退出，
 *   不去附着，也不再拉起一个带调试口的应用。run.mjs 那一侧的页面发现同样只认 jishu-hub 的页面地址。
 * - 不覆盖用户已有的 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS：原参数保留，调试口参数追加在后面；
 *   原参数里已经带调试口 → 不重复加，以用户的为准（此时让运行器用同一个端口：环境变量 JISHU_CDP_URL）。
 *
 * 退出码：0 = 调试口就绪 / 已关闭 / 无需关闭；1 = 启动失败；2 = 参数或路径问题（含不认识的参数）；
 * 3 = 应用在运行且没开调试口（未给 --restart）、有会话正在写入、或调试口上不是 jishu-hub；4 = 非 Windows。
 * 开发模式（npm run tauri dev）请自行带环境变量启动：
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run tauri dev
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPowerShell, isJishuPageUrl } from "./lib-pw.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
/** 本脚本启动的实例记录（进程号 / 路径 / 端口）。results/ 已 gitignore。 */
const STATE_FILE = path.join(HERE, "results", ".started.json");
const KNOWN_ARGS = new Set(["exe", "restart", "port", "stop", "force", "timeout", "help", "h"]);

const USAGE = `用法：node scripts/e2e/start.mjs [--exe <路径>] [--port 9222] [--restart] [--timeout 90000]   带调试口启动应用
       node scripts/e2e/start.mjs --stop [--force]                                                关闭本脚本启动的那个实例
       node scripts/e2e/start.mjs --help                                                          只打印用法
应用路径：--exe > 环境变量 JISHU_HUB_EXE > 候选里修改时间最新的一个（仓库构建 / 注册表登记的安装目录 / 常见安装目录）。
退出码：0 就绪 / 已关闭；1 启动失败；2 参数或路径问题；3 应用在运行且没开调试口（加 --restart）、有会话正在写入、或调试口上不是 jishu-hub；4 非 Windows。`;

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

/**
 * WebView2 参数怎么合并：原参数保留，调试口参数追加在后面；原参数里已经带调试口 → 原样保留、以它为准。
 * 返回 { value, port, kept }：value 是最终传给应用的值，port 是实际会生效的调试口，kept = 沿用了用户自己的。
 */
export function mergeWebviewArgs(existing, port) {
  const before = String(existing ?? "").trim();
  const mine = `--remote-debugging-port=${port}`;
  const ports = [...before.matchAll(/--remote-debugging-port(?:=|\s+)(\d+)/g)].map((m) => Number(m[1]));
  if (ports.length) return { value: before, port: ports[0], kept: true };
  return { value: before ? `${before} ${mine}` : mine, port: Number(port), kept: false };
}

/**
 * 调试口 /json/list 里像不像 jishu-hub：至少有一个页面，地址是 tauri.localhost（生产包）或
 * localhost:端口（开发模式）。返回那个页面目标；不是返回 null。
 */
export function jishuTarget(list) {
  return (Array.isArray(list) ? list : []).find((t) => t?.type === "page" && isJishuPageUrl(t?.url)) ?? null;
}

const cdpJson = async (port, route) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
};
const cdpUp = async (port) => (await cdpJson(port, "/json/version")) !== null;

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

/** 读 / 写 / 清「本脚本启动的实例」记录。 */
const readStarted = () => {
  try {
    const rec = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return Number.isInteger(rec?.pid) ? rec : null;
  } catch {
    return null;
  }
};
const writeStarted = (rec) => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(rec, null, 2));
};

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

const taskkill = (args) => new Promise((resolve) => execFile("taskkill", args, () => resolve()));

/** 关闭本脚本启动的那个实例（按进程树），并核对它退场了。 */
async function stopStarted(args) {
  const rec = readStarted();
  const others = await listHubProcesses();
  if (!rec) {
    console.log(
      others.length
        ? `没有本脚本启动的实例记录。当前有 ${others.length} 个 jishu-hub 进程在运行，但不是本脚本启动的——不动它们；要关你自己的实例请在界面里退出。`
        : "没有本脚本启动的实例，应用也未在运行。",
    );
    return 0;
  }
  const mine = others.find((p) => p.pid === rec.pid);
  if (!mine) {
    fs.rmSync(STATE_FILE, { force: true });
    console.log(
      `本脚本启动的实例（PID ${rec.pid}）已经不在了，不需要关闭。${others.length ? `当前有 ${others.length} 个别的 jishu-hub 进程在运行——不是本脚本启动的，不动它们。` : ""}`,
    );
    return 0;
  }
  // 进程号被别的程序复用、或不是记录里的那个程序 → 不动（宁可留着，也不误杀）
  const sameExe = rec.exe && mine.exe && path.resolve(rec.exe).toLowerCase() === path.resolve(mine.exe).toLowerCase();
  if (path.basename(mine.exe || "").toLowerCase() !== "jishu-hub.exe" || (rec.exe && mine.exe && !sameExe)) {
    console.error(`记录里的进程号 ${rec.pid} 现在是另一个程序（${mine.exe || "路径读不到"}），不是本脚本启动的那个 jishu-hub——不动它。`);
    return 3;
  }
  if (!args.force) {
    const active = recentSessionWrites(20000);
    if (active > 0) {
      console.error(`近 20 秒有 ${active} 个会话文件在写——像是还有回合在跑。等它结束再关，或加 --force。`);
      return 3;
    }
  }
  // /T：连同子进程（网页进程、引擎 node 进程）一起关——只关主进程会把它们留成孤儿
  await taskkill(["/PID", String(mine.pid), "/T", "/F"]);
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    await sleep(500);
    gone = !(await listHubProcesses()).some((p) => p.pid === mine.pid);
  }
  // 已经没有任何 jishu-hub 在跑时，清掉还带着本脚本那个调试口参数的网页进程：留着会被下次正常启动复用，
  // 用户平时打开的实例就带着调试口了。只清带调试口参数的，且仅在应用进程一个不剩时才动手。
  if (gone && !(await listHubProcesses()).length) {
    const port = Number(rec.port) || 9222;
    await runPowerShell(
      `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -match 'jishu-hub' -and $_.CommandLine -match '--remote-debugging-port=${port}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ).catch(() => {});
  }
  fs.rmSync(STATE_FILE, { force: true });
  console.log(
    gone
      ? `已关闭本脚本启动的实例（PID ${mine.pid}，${mine.exe}）及其子进程。`
      : `已对 PID ${mine.pid} 发出关闭，但它 10 秒内没有退场——请在任务管理器里核对。`,
  );
  return gone ? 0 : 1;
}

async function main() {
  if (process.platform !== "win32") {
    console.error("start.mjs 仅支持 Windows（依赖 WebView2 的远程调试口）。");
    return 4;
  }
  const argv = process.argv.slice(2);
  // --help / -h：只打印用法。修前不认识的参数被忽略——`--help` 会直接把应用拉起来
  if (argv.includes("-h") || argv.includes("--help") || argv.includes("--h")) {
    console.log(USAGE);
    return 0;
  }
  const args = parseArgs(argv);
  const unknown = Object.keys(args).filter((k) => !KNOWN_ARGS.has(k));
  if (unknown.length) {
    console.error(`不认识的参数：${unknown.map((k) => `--${k}`).join("、")}\n${USAGE}`);
    return 2;
  }
  const port = Number(args.port || 9222);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`调试口不合法：${args.port}\n${USAGE}`);
    return 2;
  }

  if (args.stop) return stopStarted(args);

  // 用户已有的 WebView2 参数不覆盖：调试口参数追加在后面；用户自己已经带了调试口就以他的为准
  const webview = mergeWebviewArgs(process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, port);
  if (webview.kept) {
    console.log(
      `环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 里已经带了调试口 --remote-debugging-port=${webview.port}：沿用、不覆盖。运行器要用同一个端口（环境变量 JISHU_CDP_URL=http://127.0.0.1:${webview.port}）。`,
    );
  } else if (webview.value !== `--remote-debugging-port=${port}`) {
    console.log("环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 里已有参数：保留，调试口参数追加在后面。");
  }

  if (await cdpUp(webview.port)) {
    const list = await cdpJson(webview.port, "/json/list");
    const target = jishuTarget(list);
    if (!target) {
      const pages = (Array.isArray(list) ? list : []).filter((t) => t?.type === "page").map((t) => `${t.title || "(无标题)"} ${t.url || ""}`.trim()).slice(0, 3);
      console.error(
        `端口 ${webview.port} 上开着调试口，但上面不是 jishu-hub（调试口上的页面：${pages.join(" | ") || "没有页面"}）——拒绝附着，也不另起应用。\n换一个端口：加 --port <别的端口>，并让运行器用同一个端口（环境变量 JISHU_CDP_URL）。`,
      );
      return 3;
    }
    console.log(`调试口已就绪：http://127.0.0.1:${webview.port}（调试口上是 jishu-hub：${target.title || ""} ${target.url || ""}）`);
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
      await taskkill(["/PID", String(p.pid), "/T", "/F"]);
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
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webview.value },
  });
  child.unref();
  // 记下「这是本脚本启动的」——--stop 只关这一个。单实例：应用已经在运行时这个子进程会把焦点交给它然后退出，
  // 这种情况记下的进程号很快就不在了，--stop 会如实说「已经不在了」、不去动别人的实例。
  writeStarted({ pid: child.pid, exe, port: webview.port, startedAt: new Date().toISOString() });

  const deadline = Date.now() + Number(args.timeout || 90000);
  // 调试口通了还不够：要等调试口上出现 jishu-hub 的页面（浏览器进程先起来，页面要晚一点才导航到应用地址）
  while (Date.now() < deadline) {
    if (await cdpUp(webview.port) && jishuTarget(await cdpJson(webview.port, "/json/list"))) {
      console.log(`调试口已就绪：http://127.0.0.1:${webview.port}`);
      return 0;
    }
    await sleep(500);
  }
  if (await cdpUp(webview.port)) {
    const list = await cdpJson(webview.port, "/json/list");
    const pages = (Array.isArray(list) ? list : []).filter((t) => t?.type === "page").map((t) => `${t.title || "(无标题)"} ${t.url || ""}`.trim()).slice(0, 3);
    console.error(`应用已启动，调试口也通了，但 ${webview.port} 上不是 jishu-hub 的页面（调试口上的页面：${pages.join(" | ") || "没有页面"}）——端口被别的程序占着？换 --port 再试。`);
    return 3;
  }
  console.error(`应用已启动，但 ${Math.round(Number(args.timeout || 90000) / 1000)} 秒内调试口没有就绪。`);
  return 1;
}

// 直接执行（node scripts/e2e/start.mjs …）才运行；被 import 时只导出纯函数（mergeWebviewArgs / jishuTarget）供自测。
const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedAsScript) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
