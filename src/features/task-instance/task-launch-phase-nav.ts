export type TaskLaunchNavPhase = "requirements" | "planning" | "execution";
export type TaskLaunchNavState = "done" | "active" | "ready" | "pending";

export interface TaskLaunchNavInstance {
  status?: string | null;
  current_phase?: string | null;
  requirement_file?: string | null;
  requirement_session_id?: string | null;
  planning_session_id?: string | null;
  graph_id?: string | null;
}

export interface TaskLaunchNavItem {
  phase: TaskLaunchNavPhase;
  state: TaskLaunchNavState;
  disabled: boolean;
}

export interface DeriveTaskLaunchNavItemsOptions {
  activePhase: "requirements" | "planning";
  instance: TaskLaunchNavInstance | null;
  hasRequirementConversation?: boolean;
  hasPlanningConversation?: boolean;
}

const PHASES: TaskLaunchNavPhase[] = ["requirements", "planning", "execution"];

export function deriveTaskLaunchNavItems({
  activePhase,
  instance,
  hasRequirementConversation = false,
  hasPlanningConversation = false,
}: DeriveTaskLaunchNavItemsOptions): TaskLaunchNavItem[] {
  const requirementReady = Boolean(
    instance?.requirement_file
      || instance?.requirement_session_id
      || hasRequirementConversation,
  );
  const planningReady = Boolean(
    instance?.planning_session_id
      || activePhase === "planning"
      || hasPlanningConversation,
  );
  const executionReady = Boolean(
    instance?.graph_id
      || instance?.status === "graph_created"
      || instance?.current_phase === "execution"
      || instance?.current_phase === "graph",
  );

  return PHASES.map((phase): TaskLaunchNavItem => {
    if (phase === activePhase) {
      return { phase, state: "active", disabled: false };
    }

    if (phase === "requirements") {
      return {
        phase,
        state: requirementReady ? "done" : "pending",
        disabled: !requirementReady,
      };
    }

    if (phase === "planning") {
      const done = executionReady;
      const ready = requirementReady;
      return {
        phase,
        state: done ? "done" : ready ? "ready" : "pending",
        disabled: !ready && !done,
      };
    }

    return {
      phase,
      state: executionReady ? "done" : planningReady ? "ready" : "pending",
      disabled: !executionReady && !planningReady,
    };
  });
}
