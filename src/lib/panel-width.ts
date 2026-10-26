// v0.8.0 需求4：FileViewerPanel 宽度管理的纯函数（拖拽 clamp / 持久化 / 自适应计算）。
// 持久化走 localStorage（纯 UI 偏好惯例：jishu: 前缀 + try/catch 容错）。

export const PANEL_MIN_WIDTH = 420;
/** 拖拽/自适应时为聊天主区保留的最小宽度。 */
export const MAIN_AREA_RESERVE = 320;
/** 双击自适应时在内容自然宽度之上叠加的余量（内边距 + 滚动条）。 */
export const FIT_PADDING = 48;

const STORAGE_KEY = "jishu:file-viewer-width";

export function maxPanelWidth(viewportWidth: number): number {
  return Math.max(PANEL_MIN_WIDTH, viewportWidth - mainAreaReserve(viewportWidth));
}

/** 会话列表侧栏展开宽度（chat-page 的 w-60）。 */
export const CHAT_SIDEBAR_EXPANDED = 240;

/** v0.8.0 需求4 补充：面板拖宽钳制的行内保留宽度 = 侧栏 + 对话区保底。
 *  对话区（不含会话列表侧栏）最小 = max(320px 固定下限, 窗口 20%)——用户
 *  口径的「会话区域」是对话区而非整行，侧栏宽度必须计入保留量，否则拖宽
 *  钳制会放行到「整行 20%」，对话区实际被压到更窄。侧栏收起（w-14）时
 *  本公式偏保守（对话区保底多出约 184px），可接受。
 */
export function mainAreaReserve(viewportWidth: number): number {
  return Math.max(
    MAIN_AREA_RESERVE,
    CHAT_SIDEBAR_EXPANDED + Math.round(viewportWidth * 0.2),
  );
}

export function clampPanelWidth(width: number, viewportWidth: number): number {
  const min = effectiveMinWidth(viewportWidth);
  const max = maxPanelWidth(viewportWidth);
  return Math.min(Math.max(Math.round(width), min), max);
}

/** v0.8.0 需求4 补充：默认宽度 = 应用窗口的 25%，纯百分比，不做任何
 *  最小宽度/保留量的默认值处理（用户裁决）。420px 下限仅约束拖拽。 */
export function defaultPanelWidth(viewportWidth: number): number {
  return Math.round(viewportWidth * 0.25);
}

/** 拖拽/持久化的宽度下限 = min(420px, 默认宽度)——窄窗口默认 <420px 时，
 *  从默认宽度起拖不会瞬间跳到 420px。 */
function effectiveMinWidth(viewportWidth: number): number {
  return Math.min(PANEL_MIN_WIDTH, defaultPanelWidth(viewportWidth));
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
