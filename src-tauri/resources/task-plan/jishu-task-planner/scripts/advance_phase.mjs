#!/usr/bin/env node
/**
 * advance_phase.mjs — agent 主动调用此脚本触发任务阶段推进。
 *
 * 这是任务阶段切换的**唯一触发入口**。agent 判断当前阶段已收敛后，
 * 调用此脚本（而非只在文本里说"完成了"），脚本通过 jishu-cli 推进后端状态。
 *
 * 用法（需求→规划）：
 *   node ~/.jishu-agent/task-plan/jishu-task-planner/scripts/advance_phase.mjs \
 *     --phase "planning" \
 *     --project "/path/to/project" \
 *     --requirement-file "/tmp/requirement.md" \
 *     --session "当前会话ID"
 *
 * 用法（规划→执行）：
 *   node ~/.jishu-agent/task-plan/jishu-task-planner/scripts/advance_phase.mjs \
 *     --phase "execution" \
 *     --project "/path/to/project" \
 *     --session "当前会话ID"
 *
 * --task-id 可选：如果不传，脚本用 --session 通过 jishu-cli task find 查询。
 * --session 推荐传入（agent 从 Pi get_state 获取），用于确定性地查到当前任务。
 *
 * 内部调用：jishu-cli --json task advance/find
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";

const args = process.argv.slice(2);

function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : "";
}

let taskId = getFlag("task-id");
const phase = getFlag("phase") || "planning";
const project = getFlag("project") || ".";
const requirementFile = getFlag("requirement-file");
const sessionId = getFlag("session");

if (phase !== "planning" && phase !== "execution") {
  console.error(`advance_phase.mjs: --phase must be "planning" or "execution", got: ${phase}`);
  process.exit(1);
}

const cliBin = process.env.JISHU_CLI_BIN || "jishu-cli";

console.error(`[advance_phase] using cli: ${cliBin}`);

// 如果没传 task-id，用 session-id 通过 jishu-cli task find 查询。
if (!taskId) {
  if (!sessionId) {
    console.error("advance_phase.mjs: --task-id or --session is required");
    process.exit(1);
  }
  console.error(`[advance_phase] querying task by session: ${sessionId}`);
  try {
    const findOutput = execFileSync(cliBin, [
      "--json", "task", "find",
      "--session", sessionId,
      "--project", project,
    ], { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, windowsHide: true });
    const found = JSON.parse(findOutput.trim());
    if (found && found.task_id) {
      taskId = found.task_id;
      console.error(`[advance_phase] found task_id: ${taskId}`);
    }
  } catch (e) {
    console.error(`advance_phase.mjs: task find failed: ${e.stderr || e.message}`);
    process.exit(1);
  }
}

if (!taskId) {
  console.error("advance_phase.mjs: cannot determine task_id");
  process.exit(1);
}

// Build jishu-cli args
const cliArgs = [
  "--json",
  "task",
  "advance",
  "--task-id", taskId,
  "--phase", phase,
  "--project", project,
];

if (phase === "planning") {
  if (!requirementFile) {
    console.error("advance_phase.mjs: --requirement-file is required for planning phase");
    process.exit(1);
  }
  let requirementMarkdown;
  try {
    requirementMarkdown = readFileSync(requirementFile, "utf-8");
  } catch (e) {
    console.error(`advance_phase.mjs: cannot read requirement file: ${e.message}`);
    process.exit(1);
  }
  cliArgs.push("--requirement", requirementMarkdown);
}

if (sessionId) {
  cliArgs.push("--session", sessionId);
}

console.error(`[advance_phase] args: task=${taskId} phase=${phase} project=${project}`);

try {
  const output = execFileSync(cliBin, cliArgs, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });

  const result = JSON.parse(output.trim());

  if (phase === "planning") {
    console.log(`阶段推进成功：需求讨论 → 流程规划。`);
    console.log(`任务实例 ${taskId} 状态已更新为 ${result.instance?.status ?? "planning_discussing"}。`);
    console.log(`Hub 将在当前回合完成后提示用户确认，确认后自动进入规划阶段会话。`);
  } else {
    console.log(`阶段推进成功：流程规划 → 任务执行。`);
    console.log(`Hub 将生成任务流程图并进入执行阶段。`);
  }
} catch (e) {
  const stderr = e.stderr?.trim() || e.message;
  console.error(`advance_phase.mjs: jishu-cli task advance failed: ${stderr}`);
  process.exit(1);
}
