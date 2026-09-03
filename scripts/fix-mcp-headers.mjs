#!/usr/bin/env node
/**
 * 给 mcp.json 中所有 url 类型 server 加上 Authorization header
 * pi-mcp-adapter 支持 ${ENV_VAR} 和 $env:ENV_VAR 插值
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const home = os.homedir();
const agentDir = join(home, ".jishu-agent");
const mcpPath = join(agentDir, "mcp.json");
const backupDir = join(agentDir, "backups");

mkdirSync(backupDir, { recursive: true });

// 1. 备份
const ts = new Date()
  .toISOString()
  .replace(/[-:T]/g, "")
  .slice(0, 14);
const backupPath = join(backupDir, `mcp-add-headers-${ts}.json`);
copyFileSync(mcpPath, backupPath);
console.log(`备份: ${backupPath}`);

// 2. 加载并转换
const config = JSON.parse(readFileSync(mcpPath, "utf8"));
const servers = config.mcpServers || {};

let urlCount = 0;
for (const [name, entry] of Object.entries(servers)) {
  if (entry.url && !entry.headers) {
    entry.headers = { Authorization: "Bearer ${Z_AI_API_KEY}" };
    urlCount++;
    console.log(`  ${name}: 加 headers = ${JSON.stringify(entry.headers)}`);
  }
}

writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");

console.log(`\n处理 ${urlCount} 个 url 类型 server`);

// 3. 验证
const newConfig = JSON.parse(readFileSync(mcpPath, "utf8"));
console.log("\n=== mcp.json 最终内容 ===");
console.log(JSON.stringify(newConfig, null, 2));
console.log("\n=== 验证 ===");
console.log("请确认 process.env.Z_AI_API_KEY 已设置，pi-mcp-adapter 启动时会读取");
console.log("zai-mcp-server (stdio) 不需要此 header，原样保留");
