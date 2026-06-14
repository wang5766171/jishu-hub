import { describe, it, expect, beforeEach } from "vitest";
import { loadNodePositions, saveNodePositions, clearNodePositions } from "./node-positions";

describe("node-positions", () => {
  beforeEach(() => localStorage.clear());

  it("returns null when no positions saved", () => {
    expect(loadNodePositions("g1")).toBeNull();
  });

  it("round-trips node positions", () => {
    saveNodePositions("g1", {
      n1: { x: 100, y: 200 },
      n2: { x: 300, y: 50 },
    });
    expect(loadNodePositions("g1")).toEqual({
      n1: { x: 100, y: 200 },
      n2: { x: 300, y: 50 },
    });
  });

  it("isolates positions per graph id", () => {
    saveNodePositions("g1", { n1: { x: 1, y: 2 } });
    saveNodePositions("g2", { n1: { x: 9, y: 8 } });
    expect(loadNodePositions("g1")).toEqual({ n1: { x: 1, y: 2 } });
    expect(loadNodePositions("g2")).toEqual({ n1: { x: 9, y: 8 } });
  });

  it("does not persist origin positions", () => {
    saveNodePositions("g1", { n1: { x: 0, y: 0 }, n2: { x: 5, y: 5 } });
    expect(loadNodePositions("g1")).toEqual({ n2: { x: 5, y: 5 } });
  });

  it("clears positions", () => {
    saveNodePositions("g1", { n1: { x: 1, y: 2 } });
    clearNodePositions("g1");
    expect(loadNodePositions("g1")).toBeNull();
  });

  it("rejects malformed data", () => {
    localStorage.setItem("jishu:task-node-positions:g1", "{not json");
    expect(loadNodePositions("g1")).toBeNull();
  });
});
