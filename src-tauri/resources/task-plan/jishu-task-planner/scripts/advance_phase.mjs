#!/usr/bin/env node
/**
 * advance_phase.mjs — agent 主动调用此脚本触发任务阶段推进。
 *
 * 这是任务阶段切换的**唯一触发入口**。agent 判断当前阶段已收敛后，
 * 调用此脚本（而非只在文本里说"完成了"），脚本通过 jishu-cli 推进后端状态。
 *
 * 用法（需求→规划）：
 *   node "$JISHU_TASK_PLANNER_SCRIPT_DIR/advance_phase.mjs" \
 *     --phase "planning" \
 *     --project "/path/to/project" \
 *     --requirement-file "/tmp/requirement.md" \
 *     --session "<session_id>"
 *
 * 用法（规划→执行）：
 *   node "$JISHU_TASK_PLANNER_SCRIPT_DIR/advance_phase.mjs" \
 *     --phase "execution" \
 *     --project "/path/to/project" \
 *     --session "<session_id>"
 *
 * --task-id 可选：如果不传，脚本用 --session 通过 jishu-cli task find 查询。
 * --session 推荐传入。Hub 会在发送给 agent 的消息前注入 <jishu-runtime-context>，
 * 直接读取其中的 session_id 字段即可；不要扫描 sessions 目录或猜测最新文件。
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

function logDebug(event, details = {}) {
  const safe = Object.fromEntries(
    Object.entries(details).map(([key, value]) => {
      if (/(message|content|markdown|instruction|prompt|requirement)$/i.test(key)) {
        return [key, "[omitted]"];
      }
      return [key, value ?? null];
    }),
  );
  console.log(`[task-phase][advance_phase.mjs] ${event} ${JSON.stringify(safe)}`);
}

logDebug("start", {
  phase,
  project,
  taskId: taskId || null,
  sessionId: sessionId || null,
  requirementFile: requirementFile || null,
  cliBin,
});

// 如果没传 task-id，用 session-id 通过 jishu-cli task find 查询。
if (!taskId) {
  if (!sessionId) {
    console.error("advance_phase.mjs: --task-id or --session is required");
    process.exit(1);
  }
  try {
    logDebug("find:start", {
      sessionId,
      project,
      cliBin,
    });
    const findOutput = execFileSync(cliBin, [
      "--json", "task", "find",
      "--session", sessionId,
      "--project", project,
    ], { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, windowsHide: true });
    const found = JSON.parse(findOutput.trim());
    if (found && found.task_id) {
      taskId = found.task_id;
    }
    logDebug("find:done", {
      taskId: taskId || null,
      sessionId,
      found: Boolean(taskId),
    });
  } catch (e) {
    logDebug("find:failed", {
      sessionId,
      project,
      cliBin,
    });
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

let requirementMarkdown;
if (phase === "planning") {
  if (!requirementFile) {
    console.error("advance_phase.mjs: --requirement-file is required for planning phase");
    process.exit(1);
  }
  try {
    logDebug("requirement:read:start", {
      taskId,
      requirementFile,
    });
    requirementMarkdown = readFileSync(requirementFile, "utf-8");
    logDebug("requirement:read:done", {
      taskId,
      requirementFile,
      requirementSize: requirementMarkdown.length,
    });
  } catch (e) {
    console.error(`advance_phase.mjs: cannot read requirement file: ${e.message}`);
    process.exit(1);
  }
  cliArgs.push("--requirement", "-");
}

if (sessionId) {
  cliArgs.push("--session", sessionId);
}

try {
  logDebug("advance:start", {
    taskId,
    phase,
    project,
    sessionId: sessionId || null,
    cliBin,
    hasRequirementStdin: Boolean(requirementMarkdown),
  });
  const output = execFileSync(cliBin, cliArgs, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    input: requirementMarkdown,
  });

  const result = JSON.parse(output.trim());
  logDebug("advance:done", {
    taskId,
    phase,
    status: result.instance?.status ?? null,
    currentPhase: result.instance?.current_phase ?? null,
    requirementFile: result.instance?.requirement_file ?? null,
    graphId: result.instance?.graph_id ?? null,
  });

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
  logDebug("advance:failed", {
    taskId,
    phase,
    project,
    sessionId: sessionId || null,
    cliBin,
  });
  console.error(`advance_phase.mjs: jishu-cli task advance failed: ${stderr}`);
  process.exit(1);
}
