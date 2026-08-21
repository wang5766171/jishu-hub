// v0.8.0 需求4：FileViewerPanel 宽度管理的纯函数（拖拽 clamp / 持久化 / 自适应计算）。
// 持久化走 localStorage（纯 UI 偏好惯例：jishu: 前缀 + try/catch 容错）。

export const PANEL_MIN_WIDTH = 420;
/** 拖拽/自适应时为聊天主区保留的最小宽度。 */
export const MAIN_AREA_RESERVE = 320;
/** 双击自适应时在内容自然宽度之上叠加的余量（内边距 + 滚动条）。 */
export const FIT_PADDING = 48;

const STORAGE_KEY = "jishu:file-viewer-width";

export function maxPanelWidth(viewportWidth: number): number {
  return Math.max(PANEL_MIN_WIDTH, viewportWidth - MAIN_AREA_RESERVE);
}

export function clampPanelWidth(width: number, viewportWidth: number): number {
  const min = PANEL_MIN_WIDTH;
  const max = maxPanelWidth(viewportWidth);
  return Math.min(Math.max(Math.round(width), min), max);
}

export function loadPanelWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    return clampPanelWidth(value, window.innerWidth);
  } catch {
    return null;
  }
}

export function savePanelWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // 存储不可用（隐私模式等）时静默放弃——宽度回退默认值，不影响功能。
  }
}

/** 双击自适应：内容自然宽度 + 余量，clamp 到当前窗口的合法区间。 */
export function fitPanelWidth(contentScrollWidth: number, viewportWidth: number): number {
  return clampPanelWidth(contentScrollWidth + FIT_PADDING, viewportWidth);
}
