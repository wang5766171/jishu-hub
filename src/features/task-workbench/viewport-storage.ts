/**
 * Per-graph viewport persistence (design §13.2: "用户手工位置作为软约束").
 * Pan/zoom is a pure UI preference — it never enters `GraphRevision`. Stored in
 * localStorage keyed by graph id so re-opening a task restores the user's view
 * instead of always fitting.
 */

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

const PREFIX = "jishu:task-viewport:";

export function viewportKey(graphId: string): string {
  return `${PREFIX}${graphId}`;
}

export function loadViewport(graphId: string): Viewport | null {
  try {
    const raw = localStorage.getItem(viewportKey(graphId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Viewport>;
    if (
      typeof parsed.x !== "number" ||
      typeof parsed.y !== "number" ||
      typeof parsed.zoom !== "number"
    ) {
      return null;
    }
    return { x: parsed.x, y: parsed.y, zoom: parsed.zoom };
  } catch {
    return null;
  }
}

export function saveViewport(graphId: string, viewport: Viewport): void {
  try {
    localStorage.setItem(viewportKey(graphId), JSON.stringify(viewport));
  } catch {
    // Storage may be unavailable (private mode, quota); viewport persistence is
    // best-effort and must never break the canvas.
  }
}

export function clearViewport(graphId: string): void {
  try {
    localStorage.removeItem(viewportKey(graphId));
  } catch {
    // Best-effort.
  }
}
