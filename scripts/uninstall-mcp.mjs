#!/usr/bin/env node
/**
 * 卸载 pi-mcp-adapter，恢复到完全干净状态
 * 1. 备份当前 settings.json 到 backups/
 * 2. 运行 pi remove npm:pi-mcp-adapter
 * 3. 清理 npm/node_modules/pi-mcp-adapter 残留（pi remove 有时只更新 settings 不删文件）
 * 4. 验证 settings.json 的 packages 字段已移除该包
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const home = os.homedir();
const agentDir = join(home, ".jishu-agent");
const settingsPath = join(agentDir, "settings.json");
const mcpJsonPath = join(agentDir, "mcp.json");
const backupDir = join(agentDir, "backups");
const adapterDir = join(agentDir, "npm", "node_modules", "pi-mcp-adapter");

// workspace 路径定位 cli.js
const root = process.cwd();
const cliJs = join(root, "third_party", "pi", "packages", "coding-agent", "dist", "cli.js");

mkdirSync(backupDir, { recursive: true });

// 1. 备份当前 settings.json
const ts = new Date()
  .toISOString()
  .replace(/[-:T]/g, "")
  .slice(0, 14);
const backupPath = join(backupDir, `mcp-uninstall-${ts}.json`);
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
copyFileSync(settingsPath, backupPath);
console.log(`=== 备份 ===`);
console.log(`  ${backupPath}`);
console.log(`  旧 packages: ${JSON.stringify(settings.packages)}`);
console.log("");

// 2. 运行 pi remove
console.log(`=== 运行 pi remove ===`);
const removeResult = spawnSync("node", [cliJs, "remove", "npm:pi-mcp-adapter"], {
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  encoding: "utf8",
  timeout: 60_000,
});
console.log(`  退出码: ${removeResult.status}`);
if (removeResult.stdout) console.log(`  stdout: ${removeResult.stdout.trim()}`);
if (removeResult.stderr) console.log(`  stderr: ${removeResult.stderr.trim()}`);
console.log("");

// 3. 清理残留目录（pi remove 有时不删 node_modules）
if (existsSync(adapterDir)) {
  rmSync(adapterDir, { recursive: true, force: true });
  console.log(`=== 清理残留 ===`);
  console.log(`  删除: ${adapterDir}`);
  console.log("");
}

// 4. 验证最终状态
console.log(`=== 最终状态 ===`);
const finalSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
const packages = finalSettings.packages || [];
const hasAdapter = packages.includes("npm:pi-mcp-adapter");
console.log(`  settings.json 字段: ${Object.keys(finalSettings).join(", ")}`);
console.log(`  settings.json packages: ${JSON.stringify(packages)}`);
console.log(`  adapter 目录存在: ${existsSync(adapterDir)}`);
console.log(`  mcp.json 仍存在: ${existsSync(mcpJsonPath)}`);
console.log("");

if (hasAdapter) {
  console.error(`  ✗ 卸载未完成: packages 仍含 npm:pi-mcp-adapter`);
  process.exit(1);
} else {
  console.log(`  ✓ pi-mcp-adapter 已完全卸载`);
  console.log("");
  console.log("完全干净状态：");
  console.log("  - settings.json 不含 mcpServers 和 packages");
  console.log("  - mcp.json 仍存在但内容为 { mcpServers: {} }（无影响）");
  console.log("  - npm/node_modules/pi-mcp-adapter 已删除");
  console.log("");
  console.log("重启 Jishu Hub 后：");
  console.log("  - jishu agent 状态条应不显示 MCP 状态（adapter 未加载）");
  console.log("  - 环境检测页 MCP 适配器应显示红色'未安装'");
}

