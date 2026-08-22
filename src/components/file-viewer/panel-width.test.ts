import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIT_PADDING,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  defaultPanelWidth,
  fitPanelWidth,
  loadPanelWidth,
  maxPanelWidth,
  savePanelWidth,
} from "./panel-width";

describe("defaultPanelWidth", () => {
  it("默认宽度 = 窗口 25%，非全屏窄窗口不再被 420px 下限顶替", () => {
    expect(defaultPanelWidth(1920)).toBe(480);
    expect(defaultPanelWidth(2560)).toBe(640);
    expect(defaultPanelWidth(1400)).toBe(350);
    expect(defaultPanelWidth(1200)).toBe(300);
    expect(defaultPanelWidth(800)).toBe(200);
  });
});

describe("clampPanelWidth", () => {
  it("keeps widths inside [min, viewport-reserve]", () => {
    expect(clampPanelWidth(500, 1920)).toBe(500);
    expect(clampPanelWidth(100, 1920)).toBe(PANEL_MIN_WIDTH);
    // v0.8.0 需求4 补充：保留量 = 侧栏 240 + 对话区保底（1920 窗口 20% = 384）。
    expect(clampPanelWidth(99999, 1920)).toBe(1920 - (240 + 384));
  });

  it("窄窗口下限跟随默认宽度（25% < 420px 时不再被 420 顶替）", () => {
    // 1400 窗口：默认 25% = 350 → 拖拽下限同为 350。
    expect(clampPanelWidth(100, 1400)).toBe(350);
    expect(clampPanelWidth(100, 1200)).toBe(300);
  });

  it("never returns below the minimum even on tiny windows", () => {
    expect(clampPanelWidth(600, 500)).toBe(PANEL_MIN_WIDTH);
  });
});

describe("maxPanelWidth", () => {
  it("reserves sidebar + 20% chat floor (320px floor on small windows)", () => {
    expect(maxPanelWidth(1920)).toBe(1920 - (240 + 384));
    // 1280 窗口：240 + 256 = 496 > 320。
    expect(maxPanelWidth(1280)).toBe(1280 - (240 + 256));
    // 700 窗口：240 + 140 = 380 > 320；面板上限 320 < 420 下限 → 取面板下限。
    expect(maxPanelWidth(700)).toBe(PANEL_MIN_WIDTH);
  });
});

describe("fitPanelWidth", () => {
  it("adds padding to the measured content width", () => {
    expect(fitPanelWidth(800, 1920)).toBe(800 + FIT_PADDING);
  });

  it("clamps oversized content to the window maximum", () => {
    expect(fitPanelWidth(5000, 1920)).toBe(1920 - (240 + 384));
  });
});

describe("loadPanelWidth / savePanelWidth", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips a persisted width and clamps it to the current window", () => {
    savePanelWidth(700);
    // 测试视口较窄（1024）时 700 超限被钳，随视口取钳后期望。
    expect(loadPanelWidth()).toBe(clampPanelWidth(700, window.innerWidth));
    savePanelWidth(99999);
    expect(loadPanelWidth()).toBe(maxPanelWidth(window.innerWidth));
  });

  it("returns null for missing / invalid values", () => {
    expect(loadPanelWidth()).toBeNull();
    window.localStorage.setItem("jishu:file-viewer-width", "abc");
    expect(loadPanelWidth()).toBeNull();
    window.localStorage.setItem("jishu:file-viewer-width", "-5");
    expect(loadPanelWidth()).toBeNull();
  });

  it("tolerates a throwing localStorage", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadPanelWidth()).toBeNull();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => savePanelWidth(700)).not.toThrow();
  });
});
