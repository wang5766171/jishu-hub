interface RequirementsStagePromptInput {
  taskId?: string | null;
  skillId: string;
  skillName?: string;
  projectPath?: string | null;
}

interface PlanningStagePromptInput {
  taskId?: string | null;
  requirementFile?: string | null;
  skillId: string;
  skillName?: string;
  projectPath?: string | null;
}

function skillDisplayName(skillId: string, skillName?: string): string {
  const name = skillName?.trim();
  return name && name !== skillId ? `「${name}」（skill_id: ${skillId}）` : `skill_id: ${skillId}`;
}

function projectDisplayPath(projectPath?: string | null): string {
  return projectPath?.trim() || "<当前项目路径>";
}

export function buildRequirementsStagePrompt({
  taskId,
  skillId,
  skillName,
  projectPath,
}: RequirementsStagePromptInput): string {
  const project = projectDisplayPath(projectPath);
  return [
    "<jishu-task-launch-instruction>",
    `task_id: ${taskId ?? ""}`,
    `skill_id: ${skillId}`,
    `project_path: ${project}`,
    "session_id: Hub 会在每轮发送给 agent 的消息前注入 <jishu-runtime-context>，请从其中的 session_id 字段读取真实当前会话 ID。",
    `请使用任务规划技能${skillDisplayName(skillId, skillName)}的方法论帮助用户澄清需求。`,
    "当前处于需求讨论阶段。你的职责是通过多轮对话澄清需求，不要写代码、不要输出任务流程图或执行计划。",
    '当你判断需求已经足够明确时，请使用交互式问答（request_user_input）向用户确认是否进入流程规划阶段，选项中必须包含"生成任务流程图"。',
    '用户选择"生成任务流程图"后：请在本轮回复中产出结构化的需求终稿（按技能方法论定义的格式：目标/范围/范围外/约束/验收标准/关键假设），并调用 scripts/advance_phase.mjs 推进阶段。',
    `调用方式：node ~/.jishu-agent/task-plan/jishu-task-planner/scripts/advance_phase.mjs --phase "planning" --project "${project}" --requirement-file "<需求终稿 markdown 文件>" --session "<session_id>"`,
    "调用脚本前可使用 scripts/format_requirement.mjs 将需求终稿写入临时 markdown 文件。不要自己生成流程图，也不要只用文字声明阶段完成。",
    "</jishu-task-launch-instruction>",
  ].join("\n");
}

export function buildPlanningStagePrompt({
  taskId,
  requirementFile,
  skillId,
  skillName,
  projectPath,
}: PlanningStagePromptInput): string {
  const project = projectDisplayPath(projectPath);
  return [
    "<jishu-task-planning-stage>",
    `task_id: ${taskId ?? ""}`,
    `requirement_file: ${requirementFile ?? ""}`,
    `skill_id: ${skillId}`,
    `project_path: ${project}`,
    "session_id: Hub 会在每轮发送给 agent 的消息前注入 <jishu-runtime-context>，请从其中的 session_id 字段读取真实当前会话 ID。",
    `请使用任务规划技能${skillDisplayName(skillId, skillName)}继续进行任务流程规划阶段会话。`,
    "当前处于流程规划阶段。请读取需求终稿，设计任务流程节点（明确职责、依赖、验收口径、人工确认点），并与用户讨论调整。",
    "不要执行任务代码；不要要求用户去画布点击智能规划。规划在会话里完成，阶段推进只能通过 scripts/advance_phase.mjs 触发。",
    '当流程方案稳定后，请使用交互式问答（request_user_input）向用户确认是否生成任务流程图，选项中必须包含"确认生成任务流程图"。',
    '用户确认后：说明"流程规划阶段完成，将生成任务流程图并进入执行阶段"，并调用 scripts/advance_phase.mjs 推进阶段。',
    `调用方式：node ~/.jishu-agent/task-plan/jishu-task-planner/scripts/advance_phase.mjs --phase "execution" --project "${project}" --session "<session_id>"`,
    "不要自己调用任何生成图工具；Hub 会在检测到后端状态变化后生成流程图并绑定到任务实例。",
    "</jishu-task-planning-stage>",
  ].join("\n");
}
