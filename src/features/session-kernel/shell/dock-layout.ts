/**
 * 会话区拖拽布局状态机（v0.9.2 需求1 P2）。
 *
 * 两层控制语义（用户裁决）：插件中心 = 能力**存不存在**；本布局 = 已启用能力
 * **显示在哪/是否收起**。布局是纯视觉状态 → localStorage（显示层缓存），
 * 损坏/未知字段静默丢弃回默认（与画布 viewport-storage 同策略）。
 *
 * 停靠模型（五槽位预定义，不做自由分割）：面板可停靠 left/right/top/bottom
 * 或浮动（可调大小）；贴边挂件仅 left/right 两缘。
 */

export type RailSide = "left" | "right";

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type DockSlot = "left" | "right" | "top" | "bottom" | "float";

export interface PanelLayout {
  slot: DockSlot;
  /** 呈现层显隐（快捷图标/收起钮控制；≠ 插件启停）。 */
  hidden: boolean;
  /** 浮动面板位置与大小（仅 slot=float 时有意义）。 */
  floatRect?: FloatRect;
}

export interface RailWidgetLayout {
  side: RailSide;
}

export interface SessionLayoutState {
  panels: Record<string, PanelLayout>;
  railWidgets: Record<string, RailWidgetLayout>;
}

const STORAGE_KEY = "jishu-hub.session-layout.v1";

/** 浮动窗口尺寸保护。 */
export const FLOAT_MIN_W = 280;
export const FLOAT_MIN_H = 180;
/** 边缘停靠列宽（左右缘面板列）。 */
export const EDGE_PANEL_WIDTH = 340;

export function defaultLayout(): SessionLayoutState {
  return { panels: {}, railWidgets: {} };
}

/** 把任意 JSON 修正为合法布局（未知插件条目保留——禁用重启用恢复原位）。 */
export function sanitizeLayout(raw: unknown): SessionLayoutState {
  const result = defaultLayout();
  if (typeof raw !== "object" || raw === null) return result;
  const record = raw as Record<string, unknown>;
  if (typeof record.panels === "object" && record.panels !== null) {
    for (const [id, value] of Object.entries(record.panels as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const panel = value as Record<string, unknown>;
      const slot = panel.slot;
      if (slot !== "left" && slot !== "right" && slot !== "top" && slot !== "bottom" && slot !== "float") {
        continue;
      }
      const layout: PanelLayout = { slot, hidden: panel.hidden === true };
      if (slot === "float") {
        const rect = sanitizeFloatRect(panel.floatRect);
        if (rect) layout.floatRect = rect;
      }
      result.panels[id] = layout;
    }
  }
  if (typeof record.railWidgets === "object" && record.railWidgets !== null) {
    for (const [id, value] of Object.entries(record.railWidgets as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const widget = value as Record<string, unknown>;
      result.railWidgets[id] = { side: widget.side === "right" ? "right" : "left" };
    }
  }
  return result;
}

export function sanitizeFloatRect(raw: unknown): FloatRect | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rect = raw as Record<string, unknown>;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Number(rect.w);
  const h = Number(rect.h);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return undefined;
  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    w: Math.max(FLOAT_MIN_W, w),
    h: Math.max(FLOAT_MIN_H, h),
  };
}

export function loadLayout(): SessionLayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultLayout();
    return sanitizeLayout(JSON.parse(raw));
  } catch {
    return defaultLayout();
  }
}

export function saveLayout(state: SessionLayoutState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 写失败静默降级（下次写入自愈）
  }
}

/** 面板布局读取：无记录时按默认槽位落位。 */
export function panelLayoutOf(
  state: SessionLayoutState,
  panelId: string,
  defaultSlot: DockSlot,
): PanelLayout {
  // v0.9.2 用户裁决：全新安装（无布局记录）默认**收起**——此前 hidden:false
  // 导致首次启动所有面板自动展开（搜索浮窗飘在左上角、能力中心全选中）。
  // 用户经能力中心手动展开后写入布局记忆，此后跟随记忆。
  return state.panels[panelId] ?? { slot: defaultSlot, hidden: true };
}

/** 贴边挂件缘位读取：无记录时默认左缘。 */
export function railWidgetSideOf(
  state: SessionLayoutState,
  widgetId: string,
  fallback: RailSide = "left",
): RailSide {
  return state.railWidgets[widgetId]?.side ?? fallback;
}

/** 浮动矩形拖到屏幕外的回拉（clamp 到视口内至少留 40px 把手）。 */
export function clampFloatRect(rect: FloatRect, viewport: { w: number; h: number }): FloatRect {
  const w = Math.min(Math.max(rect.w, FLOAT_MIN_W), Math.max(viewport.w, FLOAT_MIN_W));
  const h = Math.min(Math.max(rect.h, FLOAT_MIN_H), Math.max(viewport.h, FLOAT_MIN_H));
  return {
    w,
    h,
    x: Math.min(Math.max(0, rect.x), Math.max(0, viewport.w - 40)),
    y: Math.min(Math.max(0, rect.y), Math.max(0, viewport.h - 40)),
  };
}
