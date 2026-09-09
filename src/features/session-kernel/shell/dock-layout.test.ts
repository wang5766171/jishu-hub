import { describe, expect, it } from "vitest";
import {
  clampFloatRect,
  defaultLayout,
  FLOAT_MIN_H,
  FLOAT_MIN_W,
  panelLayoutOf,
  railWidgetSideOf,
  sanitizeLayout,
} from "./dock-layout";

describe("dock-layout（v0.9.2 需求1 P2 布局状态机）", () => {
  it("损坏输入静默回默认（显示层缓存不拖垮会话）", () => {
    expect(sanitizeLayout(null)).toEqual(defaultLayout());
    expect(sanitizeLayout("junk")).toEqual(defaultLayout());
    expect(sanitizeLayout({ panels: "junk" }).panels).toEqual({});
    expect(sanitizeLayout({ panels: { p1: { slot: "diagonal" } } }).panels).toEqual({});
  });

  it("合法条目保留（含未知插件——禁用重启用恢复原位）", () => {
    const layout = sanitizeLayout({
      panels: {
        "session.flow": { slot: "right", hidden: true },
        "session.search": { slot: "float", hidden: false, floatRect: { x: -5, y: 10, w: 10, h: 100 } },
      },
      railWidgets: { "session.navigation": { side: "right" } },
    });
    expect(layout.panels["session.flow"]).toEqual({ slot: "right", hidden: true });
    expect(layout.panels["session.search"].slot).toBe("float");
    // 负坐标回拉、尺寸钳制
    expect(layout.panels["session.search"].floatRect?.x).toBe(0);
    expect(layout.panels["session.search"].floatRect?.w).toBe(FLOAT_MIN_W);
    expect(layout.railWidgets["session.navigation"].side).toBe("right");
  });

  it("无记录时按默认槽位落位、挂件默认左缘", () => {
    const layout = defaultLayout();
    expect(panelLayoutOf(layout, "session.flow", "right")).toEqual({ slot: "right", hidden: false });
    expect(railWidgetSideOf(layout, "session.navigation")).toBe("left");
  });

  it("浮动矩形拖出屏幕回拉且不小于最小尺寸", () => {
    const clamped = clampFloatRect({ x: -999, y: -999, w: 10, h: 10 }, { w: 1200, h: 800 });
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
    expect(clamped.w).toBe(FLOAT_MIN_W);
    expect(clamped.h).toBe(FLOAT_MIN_H);
    const pinned = clampFloatRect({ x: 5000, y: 5000, w: 400, h: 500 }, { w: 1200, h: 800 });
    expect(pinned.x).toBeLessThanOrEqual(1200 - 40);
    expect(pinned.y).toBeLessThanOrEqual(800 - 40);
  });
});
