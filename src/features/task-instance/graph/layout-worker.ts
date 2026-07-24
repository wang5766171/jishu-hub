/// <reference lib="webworker" />
import { computeLayout, type LayoutGraph, type LayoutResult } from "./layout";

/**
 * Web Worker entry point for graph layout (design §13.2: "全图布局在 Web Worker
 * 中执行"). Runs `computeLayout` off the main thread so a 500-node canvas stays
 * interactive. The main thread posts a `LayoutGraph`, the worker posts back a
 * `LayoutResult`.
 */
self.onmessage = (event: MessageEvent<LayoutGraph>) => {
  const result: LayoutResult = computeLayout(event.data);
  (self as unknown as Worker).postMessage(result);
};

export {};
