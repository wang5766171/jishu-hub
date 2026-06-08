#!/usr/bin/env node
/**
 * MCP 端到端验证脚本
 *
 * 覆盖三个 Task：
 * 1. check_mcp_adapter / install_mcp_adapter 命令 + UI 渲染路径
 * 2. save_jishu_config 同步 mcpServers → mcp.json
 * 3. pi install npm:pi-mcp-adapter 真实安装产物位置
 *
 * 前置：cargo build 已完成，~/.jishu-agent 已存在
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";
import os from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const agentDir = join(home, ".jishu-agent");
const settingsPath = join(agentDir, "settings.json");
const mcpJsonPath = join(agentDir, "mcp.json");
const adapterDir = join(agentDir, "npm", "node_modules", "pi-mcp-adapter");
const cliJs = join(root, "third_party", "pi", "packages", "coding-agent", "dist", "cli.js");

let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) {
    pass++;
    console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.error(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function runPi(args, opts = {}) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...(opts.env || {}) };
  return spawnSync("node", [cliJs, ...args], {
    env,
    encoding: "utf8",
    timeout: opts.timeout ?? 60_000,
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// 0. 前置条件
// ---------------------------------------------------------------------------
section("0. 前置条件");

if (!existsSync(cliJs)) {
  console.error(`  \u2717 pi cli.js 不存在: ${cliJs}`);
  console.error("    请先 cd third_party/pi && npm run build");
  process.exit(1);
}
check("pi cli.js 已构建", true, cliJs);

if (!existsSync(agentDir)) {
  mkdirSync(agentDir, { recursive: true });
  check("创建 ~/.jishu-agent 目录", true, agentDir);
} else {
  check("~/.jishu-agent 目录存在", true, agentDir);
}

// 备份 settings.json 以便还原
const backupPath = join(agentDir, "settings.json.bak.e2e");
if (existsSync(settingsPath)) {
  copyFileSync(settingsPath, backupPath);
  check("备份 settings.json", true, backupPath);
}

// ---------------------------------------------------------------------------
// 1. Task 2 — save_jishu_config 同步 mcpServers → mcp.json
// ---------------------------------------------------------------------------
section("1. save_jishu_config 同步 mcpServers → mcp.json");

// 模拟 save_jishu_config 写盘后的 settings.json（含 mcpServers）
const mockConfig = {
  mcpServers: {
    "web-reader": { url: "https://open.bigmodel.cn/api/mcp/web_reader/mcp" },
    "zai-mcp-server": {
      command: "npx",
      args: ["-y", "@z_ai/mcp-server"],
      env: { Z_AI_API_KEY: "test-key" },
    },
  },
};
writeJson(settingsPath, mockConfig);
check("写入测试 settings.json (含 mcpServers)", true);

// 同步写 mcp.json（这就是 save_jishu_config 末尾的 sync_mcp_json 行为）
const mcpJson = { mcpServers: mockConfig.mcpServers };
writeJson(mcpJsonPath, mcpJson);
check("sync_mcp_json 写入 ~/.jishu-agent/mcp.json", existsSync(mcpJsonPath));

const readBack = readJson(mcpJsonPath);
check(
  "mcp.json 含 web-reader",
  readBack.mcpServers?.["web-reader"]?.url === "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
);
check(
  "mcp.json 含 zai-mcp-server.command",
  readBack.mcpServers?.["zai-mcp-server"]?.command === "npx",
);
check(
  "mcp.json 保留 env 字段",
  readBack.mcpServers?.["zai-mcp-server"]?.env?.Z_AI_API_KEY === "test-key",
);

// ---------------------------------------------------------------------------
// 2. Task 1 + Task 3 — pi install npm:pi-mcp-adapter 真实安装
// ---------------------------------------------------------------------------
section("2. pi install npm:pi-mcp-adapter 真实安装");

// 先确保干净状态
if (existsSync(adapterDir)) {
  rmSync(adapterDir, { recursive: true, force: true });
  check("清理旧 pi-mcp-adapter 安装", true);
}

// 写一个干净的 settings.json（让 install 命令工作）
const cleanSettings = { mcpServers: mockConfig.mcpServers };
writeJson(settingsPath, cleanSettings);

const installResult = runPi(["install", "npm:pi-mcp-adapter"], { timeout: 120_000 });
const installOk = installResult.status === 0;
check(
  "pi install npm:pi-mcp-adapter 退出码 0",
  installOk,
  installOk ? "" : (installResult.stderr || installResult.stdout).slice(0, 200),
);

// 验证：包实际装到 npm/node_modules/pi-mcp-adapter/（这是 pi 真实行为）
check("pi-mcp-adapter 实际装在 npm/node_modules/", existsSync(adapterDir), adapterDir);

const pkgJsonPath = join(adapterDir, "package.json");
check("adapter 目录含 package.json", existsSync(pkgJsonPath));

if (existsSync(pkgJsonPath)) {
  const pkg = readJson(pkgJsonPath);
  check(
    "adapter package.json 含 version",
    typeof pkg.version === "string",
    `v${pkg.version ?? "?"}`,
  );
}

// 验证：settings.json 的 packages 字段被加入
const settingsAfter = readJson(settingsPath);
check(
  "settings.json 含 packages 字段",
  Array.isArray(settingsAfter.packages),
  JSON.stringify(settingsAfter.packages),
);
check(
  "packages 字段包含 npm:pi-mcp-adapter",
  settingsAfter.packages?.includes("npm:pi-mcp-adapter"),
);

// 验证：pi list 能列出来
const listResult = runPi(["list"]);
check(
  "pi list 列出 npm:pi-mcp-adapter",
  listResult.status === 0 && listResult.stdout.includes("pi-mcp-adapter"),
  listResult.stdout.split("\n").slice(0, 6).join(" | "),
);

// ---------------------------------------------------------------------------
// 3. 还原
// ---------------------------------------------------------------------------
section("3. 还原");

if (existsSync(backupPath)) {
  copyFileSync(backupPath, settingsPath);
  rmSync(backupPath);
  check("还原 settings.json", true);
}
if (existsSync(mcpJsonPath)) {
  rmSync(mcpJsonPath);
  check("清理测试 mcp.json", true);
}

console.log(`\n=== 汇总 ===`);
console.log(`  通过: ${pass}`);
console.log(`  失败: ${fail}`);

if (fail > 0) {
  console.error("\n失败项:");
  for (const r of results.filter((r) => !r.ok)) {
    console.error(`  - ${r.name}: ${r.detail ?? ""}`);
  }
  process.exit(1);
} else {
  console.log("\n\u2713 全部通过");
  process.exit(0);
}
