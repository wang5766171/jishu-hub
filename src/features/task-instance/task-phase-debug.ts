const TASK_PHASE_DEBUG_PREFIX = "[task-phase]";
const SENSITIVE_KEY_PATTERN = /(message|content|markdown|instruction|prompt)/i;

export type TaskPhaseDebugDetails = Record<string, unknown>;

function sanitizeTaskPhaseDebugValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[omitted]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return `[array:${value.length}]`;
  return "[object]";
}

export function buildTaskPhaseDebugPayload(details: TaskPhaseDebugDetails): TaskPhaseDebugDetails {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      sanitizeTaskPhaseDebugValue(key, value),
    ]),
  );
}

export function logTaskPhaseDebug(event: string, details: TaskPhaseDebugDetails = {}) {
  const payload = buildTaskPhaseDebugPayload(details);
  if (Object.keys(payload).length === 0) {
    console.info(TASK_PHASE_DEBUG_PREFIX, event);
    return;
  }
  console.info(TASK_PHASE_DEBUG_PREFIX, event, payload);
}
