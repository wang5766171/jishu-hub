#!/usr/bin/env node
/**
 * format_flow_plan.mjs — 将流程规划讨论的节点信息格式化为标准流程方案文本。
 *
 * Agent 调用方式：
 *   node ~/.jishu-agent/task-plan/jishu-task-planner/scripts/format_flow_plan.mjs \
 *     --nodes '环境准备|安装依赖、配置构建||基础组件升级|替换核心组件库|环境准备'
 *
 * --nodes 格式：节点之间用双竖线 || 分隔，每个节点三段用单竖线 | 分隔：
 *   标题|职责描述|前置依赖(逗号分隔的节点标题，无依赖则空)
 *
 * 输出标准格式的流程方案到 stdout。
 */
const args = process.argv.slice(2);

function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : "";
}

const nodesRaw = getFlag("nodes") || "";

const nodes = nodesRaw
  .split("||")
  .map((raw) => raw.trim())
  .filter(Boolean)
  .map((raw) => {
    const parts = raw.split("|").map((s) => s.trim());
    return {
      title: parts[0] || "(未命名节点)",
      responsibility: parts[1] || "",
      dependsOn: parts[2] || "",
    };
  });

const lines = [];
lines.push("## 建议的任务流程方案", "");

if (nodes.length === 0) {
  lines.push("(待补充节点)");
} else {
  lines.push(`共 ${nodes.length} 个节点：`, "");
  nodes.forEach((node, i) => {
    const dep = node.dependsOn ? `（依赖：${node.dependsOn}）` : "（无依赖，可立即开始）";
    lines.push(`${i + 1}. **${node.title}**${dep}`);
    if (node.responsibility) {
      lines.push(`   - 职责：${node.responsibility}`);
    }
  });
}

lines.push("", "---", "");
lines.push("以上为初步方案，你可以要求增删节点、调整依赖或优先级。确认后我将发起流程图生成确认。");

process.stdout.write(lines.join("\n"));
