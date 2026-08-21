import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIT_PADDING,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  fitPanelWidth,
  loadPanelWidth,
  maxPanelWidth,
  savePanelWidth,
} from "./panel-width";

describe("clampPanelWidth", () => {
  it("keeps widths inside [min, viewport-reserve]", () => {
    expect(clampPanelWidth(500, 1920)).toBe(500);
    expect(clampPanelWidth(100, 1920)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(99999, 1920)).toBe(1920 - 320);
  });

  it("never returns below the minimum even on tiny windows", () => {
    expect(clampPanelWidth(600, 500)).toBe(PANEL_MIN_WIDTH);
  });
});

describe("maxPanelWidth", () => {
  it("reserves the main chat area", () => {
    expect(maxPanelWidth(1920)).toBe(1600);
    expect(maxPanelWidth(700)).toBe(PANEL_MIN_WIDTH);
  });
});

describe("fitPanelWidth", () => {
  it("adds padding to the measured content width", () => {
    expect(fitPanelWidth(800, 1920)).toBe(800 + FIT_PADDING);
  });

  it("clamps oversized content to the window maximum", () => {
    expect(fitPanelWidth(5000, 1920)).toBe(1600);
  });
});

describe("loadPanelWidth / savePanelWidth", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips a persisted width and clamps it to the current window", () => {
    savePanelWidth(700);
    expect(loadPanelWidth()).toBe(700);
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
