import { describe, expect, it } from "vitest";
import {
  buildPlanningStagePrompt,
  buildRequirementsStagePrompt,
} from "./task-phase-prompts";

describe("task phase prompts", () => {
  it("instructs requirements agents to advance with the phase script", () => {
    const prompt = buildRequirementsStagePrompt({
      skillId: "jishu-task-planner",
      skillName: "技枢任务规划",
      projectPath: "D:/workspace/demo",
    });

    expect(prompt).toContain("advance_phase.mjs");
    expect(prompt).toContain('--phase "planning"');
    expect(prompt).toContain("--requirement-file");
    expect(prompt).not.toContain("系统会自动推进");
  });

  it("instructs planning agents to advance execution with the phase script", () => {
    const prompt = buildPlanningStagePrompt({
      taskId: "task_1",
      requirementFile: "D:/workspace/demo/.jishu-hub/tasks/task_1/requirements/requirements.md",
      skillId: "jishu-task-planner",
      skillName: "技枢任务规划",
      projectPath: "D:/workspace/demo",
    });

    expect(prompt).toContain("advance_phase.mjs");
    expect(prompt).toContain('--phase "execution"');
    expect(prompt).not.toContain("系统会自动调用编排引擎");
  });
});
