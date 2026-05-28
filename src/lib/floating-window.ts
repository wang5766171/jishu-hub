import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

const floatingWindows = new Map<string, WebviewWindow>();
const FLOAT_WIDTH = 320;
const FLOAT_HEIGHT = 120;
const FLOAT_GAP = 8;

export async function openFloatingSession(
  sessionId: string,
  sessionName: string,
  agentId: string,
  projectEncoded: string,
  agentName?: string,
) {
  // If already open, focus it
  const existing = floatingWindows.get(sessionId);
  if (existing) {
    try {
      await existing.setFocus();
      return;
    } catch {
      floatingWindows.delete(sessionId);
    }
  }

  // Calculate position: outside main window's left edge, stacked vertically
  let x = 20, y = 20;
  try {
    const mainWin = getCurrentWindow();
    const pos = await mainWin.outerPosition();
    const size = await mainWin.outerSize();
    const isFullscreen = await mainWin.isFullscreen();
    const isMaximized = await mainWin.isMaximized();

    if (isFullscreen || isMaximized) {
      // Fallback: top-left corner of screen
      x = 20;
      y = 20;
    } else {
      // Place to the left of the main window, aligned to top
      x = pos.x - FLOAT_WIDTH - FLOAT_GAP;
      y = pos.y;
      // If no room on the left, place to the right
      if (x < 0) {
        x = pos.x + size.width + FLOAT_GAP;
      }
    }
  } catch {
    // fallback
  }

  // Stack multiple floating windows vertically
  const existingCount = floatingWindows.size;
  y += existingCount * (FLOAT_HEIGHT + FLOAT_GAP);

  const label = `floating-${sessionId.slice(0, 8)}`;
  const url = `index.html?floating=${sessionId}&name=${encodeURIComponent(sessionName)}&agent=${encodeURIComponent(agentId)}&project=${encodeURIComponent(projectEncoded)}&agentName=${encodeURIComponent(agentName ?? agentId)}`;

  const win = new WebviewWindow(label, {
    url,
    title: sessionName,
    width: FLOAT_WIDTH,
    height: FLOAT_HEIGHT,
    minWidth: 240,
    minHeight: 80,
    resizable: true,
    decorations: false,
    alwaysOnTop: true,
    center: false,
    x,
    y,
    transparent: false,
  });

  win.once("tauri://error", () => {
    floatingWindows.delete(sessionId);
  });

  win.once("tauri://destroyed", () => {
    floatingWindows.delete(sessionId);
  });

  floatingWindows.set(sessionId, win);
}

export function closeFloatingSession(sessionId: string) {
  const win = floatingWindows.get(sessionId);
  if (win) {
    win.close().catch(() => {});
    floatingWindows.delete(sessionId);
  }
}

export function isFloatingOpen(sessionId: string): boolean {
  return floatingWindows.has(sessionId);
}
