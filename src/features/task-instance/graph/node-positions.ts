/**
 * Per-graph node position persistence (design §13.2: "用户手工位置作为软约束").
 *
 * Positions are pure UI state — never written to GraphRevision. Saved to
 * localStorage keyed by graph_id so re-entering a task restores the layout
 * the user left it in (no re-overlap on re-entry).
 */

const PREFIX = "jishu:task-node-positions:";

export type NodePositions = Record<string, { x: number; y: number }>;

function key(graphId: string): string {
  return `${PREFIX}${graphId}`;
}

/** Load saved node positions for a graph. Returns null if none saved. */
export function loadNodePositions(graphId: string): NodePositions | null {
  try {
    const raw = localStorage.getItem(key(graphId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: NodePositions = {};
    for (const [nodeId, value] of Object.entries(parsed)) {
      if (
        value &&
        typeof value === "object" &&
        typeof (value as Record<string, unknown>).x === "number" &&
        typeof (value as Record<string, unknown>).y === "number"
      ) {
        const v = value as { x: number; y: number };
        result[nodeId] = { x: v.x, y: v.y };
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

/** Save node positions for a graph (best-effort). */
export function saveNodePositions(graphId: string, positions: NodePositions): void {
  try {
    // Only save positions for nodes that have been moved away from origin
    // (dagre-computed or user-dragged). This keeps localStorage small and
    // avoids persisting the default {0,0}.
    const moved: NodePositions = {};
    for (const [nodeId, pos] of Object.entries(positions)) {
      if (pos.x !== 0 || pos.y !== 0) {
        moved[nodeId] = pos;
      }
    }
    if (Object.keys(moved).length === 0) {
      localStorage.removeItem(key(graphId));
    } else {
      localStorage.setItem(key(graphId), JSON.stringify(moved));
    }
  } catch {
    // Best-effort — storage may be unavailable.
  }
}

/** Clear saved positions for a graph. */
export function clearNodePositions(graphId: string): void {
  try {
    localStorage.removeItem(key(graphId));
  } catch {
    // Best-effort.
  }
}
