import { describe, expect, it } from "vitest";

import { buildTaskPhaseDebugPayload } from "./task-phase-debug";

describe("buildTaskPhaseDebugPayload", () => {
  it("keeps diagnostic fields while omitting conversational content", () => {
    expect(buildTaskPhaseDebugPayload({
      taskId: "task_1",
      phase: "planning",
      status: "planning_discussing",
      sessionId: "session_1",
      graphId: null,
      agentMessage: "hidden instructions",
      requirementMarkdown: "# private draft",
      planningInstruction: "private plan",
      prompt: "private prompt",
      nested: { value: 1 },
      ids: ["a", "b"],
    })).toEqual({
      taskId: "task_1",
      phase: "planning",
      status: "planning_discussing",
      sessionId: "session_1",
      graphId: null,
      agentMessage: "[omitted]",
      requirementMarkdown: "[omitted]",
      planningInstruction: "[omitted]",
      prompt: "[omitted]",
      nested: "[object]",
      ids: "[array:2]",
    });
  });
});
