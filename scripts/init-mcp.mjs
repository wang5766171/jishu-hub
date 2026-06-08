#!/usr/bin/env node
/**
 * 初始化 MCP 配置到干净状态
 * 1. 备份当前 settings.json 中的 mcpServers 到 backups/mcp-init-<ts>.json
 * 2. 清空 settings.json 中的 mcpServers 字段
 * 3. 重置 mcp.json 为空配置
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const home = os.homedir();
const agentDir = join(home, ".jishu-agent");
const settingsPath = join(agentDir, "settings.json");
const mcpJsonPath = join(agentDir, "mcp.json");
const backupDir = join(agentDir, "backups");

mkdirSync(backupDir, { recursive: true });

const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const oldServers = settings.mcpServers || {};

const ts = new Date()
  .toISOString()
  .replace(/[-:T]/g, "")
  .slice(0, 14);
const backupPath = join(backupDir, `mcp-init-${ts}.json`);

const backupContent = {
  initialized_at: new Date().toISOString(),
  settings_mcpServers: oldServers,
};
writeFileSync(backupPath, JSON.stringify(backupContent, null, 2));

// 清空 settings.json 中的 mcpServers 字段
delete settings.mcpServers;
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

// 同步重置 mcp.json
writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: {} }, null, 2) + "\n");

console.log("=== 初始化完成 ===");
console.log(`  备份文件: ${backupPath}`);
console.log(`  旧 mcpServers 数量: ${Object.keys(oldServers).length}`);
console.log(
  `  旧 mcpServers 名称: ${Object.keys(oldServers).join(", ") || "(无)"}`
);
console.log("");
console.log("  settings.json 已清理 mcpServers 字段");
console.log("  mcp.json 已重置为空配置");
console.log("");
console.log("=== 当前状态 ===");
const newSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
console.log(`settings.json 字段: ${Object.keys(newSettings).join(", ")}`);
console.log(
  `mcp.json 内容: ${readFileSync(mcpJsonPath, "utf8").trim()}`
);
console.log("");
console.log("下一步：重启 Jishu Hub，pi-mcp-adapter 会重新加载 mcp.json，");
console.log("       此时应显示 'MCP: 0/0 servers, 0 tools'");
console.log("       然后在 GUI 中添加 MCP server 即可开始测试");
