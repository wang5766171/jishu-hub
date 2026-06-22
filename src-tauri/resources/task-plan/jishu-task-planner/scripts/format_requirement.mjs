#!/usr/bin/env node
/**
 * format_requirement.mjs — 将需求讨论的关键信息格式化为标准需求终稿。
 *
 * Agent 调用方式（Pi 工具执行 bash）：
 *   node ~/.jishu-agent/task-plan/jishu-task-planner/scripts/format_requirement.mjs \
 *     --title "任务标题" \
 *     --goal "一句话目标" \
 *     --scope "范围1;范围2;范围3" \
 *     --out-scope "排除1;排除2" \
 *     --constraints "约束1;约束2" \
 *     --acceptance "验收1;验收2" \
 *     --assumptions "假设1;假设2"
 *
 * 分号分隔的列表会被拆成逐条。输出标准格式的 markdown 终稿到 stdout。
 * Agent 把 stdout 内容作为需求终稿回复给用户。
 */
const args = process.argv.slice(2);

function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : "";
}

function splitList(value) {
  return value
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

const title = getFlag("title") || "未命名任务";
const goal = getFlag("goal") || "(待补充)";
const scope = splitList(getFlag("scope"));
const outScope = splitList(getFlag("out-scope"));
const constraints = splitList(getFlag("constraints"));
const acceptance = splitList(getFlag("acceptance"));
const assumptions = splitList(getFlag("assumptions"));

const lines = [];

lines.push(`# ${title}`, "");
lines.push("## 目标", goal, "");

lines.push("## 范围");
if (scope.length > 0) {
  scope.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
} else {
  lines.push("(待补充)");
}
lines.push("");

lines.push("## 范围外（不做什么）");
if (outScope.length > 0) {
  outScope.forEach((item) => lines.push(`- ${item}`));
} else {
  lines.push("(无明确排除)");
}
lines.push("");

lines.push("## 约束条件");
if (constraints.length > 0) {
  constraints.forEach((item) => lines.push(`- ${item}`));
} else {
  lines.push("(无特殊约束)");
}
lines.push("");

lines.push("## 验收标准");
if (acceptance.length > 0) {
  acceptance.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
} else {
  lines.push("(待补充)");
}
lines.push("");

lines.push("## 关键假设");
if (assumptions.length > 0) {
  assumptions.forEach((item) => lines.push(`- ${item}`));
} else {
  lines.push("(无)");
}
lines.push("");

process.stdout.write(lines.join("\n"));
