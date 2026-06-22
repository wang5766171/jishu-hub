export interface TaskPhaseAdvanceInstance {
  status: string;
  current_phase: string;
  title: string;
  requirement_file?: string | null;
}

export interface TaskPhaseAdvancePrompt {
  taskId: string;
  fromPhase: "requirements" | "planning";
  toPhase: "planning" | "execution";
  planningInstruction: string | null;
  title: string;
}

export function detectTaskPhaseAdvancePrompt({
  taskId,
  previousStatus,
  instance,
}: {
  taskId: string;
  previousStatus: string | null;
  instance: TaskPhaseAdvanceInstance;
}): TaskPhaseAdvancePrompt | null {
  if (!previousStatus || previousStatus === instance.status) {
    return null;
  }

  if (
    previousStatus === "requirements_discussing"
    && (instance.status === "requirements_finalized" || instance.status === "planning_discussing")
    && instance.requirement_file
  ) {
    return {
      taskId,
      fromPhase: "requirements",
      toPhase: "planning",
      planningInstruction: null,
      title: instance.title,
    };
  }

  if (
    previousStatus === "planning_discussing"
    && instance.status === "graph_created"
    && instance.current_phase === "execution"
  ) {
    return {
      taskId,
      fromPhase: "planning",
      toPhase: "execution",
      planningInstruction: null,
      title: instance.title,
    };
  }

  return null;
}
