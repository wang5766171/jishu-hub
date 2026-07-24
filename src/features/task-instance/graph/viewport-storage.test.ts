import { describe, it, expect, beforeEach } from "vitest";
import { loadViewport, saveViewport, clearViewport, viewportKey } from "./viewport-storage";

describe("viewport-storage", () => {
  beforeEach(() => localStorage.clear());

  it("returns null when no viewport is saved", () => {
    expect(loadViewport("g1")).toBeNull();
  });

  it("round-trips a viewport", () => {
    saveViewport("g1", { x: 10, y: 20, zoom: 1.5 });
    expect(loadViewport("g1")).toEqual({ x: 10, y: 20, zoom: 1.5 });
  });

  it("isolates viewports per graph id", () => {
    saveViewport("g1", { x: 1, y: 2, zoom: 1 });
    saveViewport("g2", { x: 9, y: 8, zoom: 2 });
    expect(loadViewport("g1")).toEqual({ x: 1, y: 2, zoom: 1 });
    expect(loadViewport("g2")).toEqual({ x: 9, y: 8, zoom: 2 });
  });

  it("clears a viewport", () => {
    saveViewport("g1", { x: 1, y: 2, zoom: 1 });
    clearViewport("g1");
    expect(loadViewport("g1")).toBeNull();
  });

  it("rejects malformed stored viewport", () => {
    localStorage.setItem(viewportKey("g1"), "{not json");
    expect(loadViewport("g1")).toBeNull();
    localStorage.setItem(viewportKey("g1"), JSON.stringify({ x: 1 }));
    expect(loadViewport("g1")).toBeNull();
  });
});
