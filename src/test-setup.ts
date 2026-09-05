import "@testing-library/jest-dom";

// jsdom 不实现 ResizeObserver——提供 no-op stub（回调不触发，使用方依赖
// 挂载期同步或事件驱动的路径照常工作）。v0.9.1 需求4：chat-input 高度
// 等比伸缩的容器观察。
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    constructor(_callback: ResizeObserverCallback) {}
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
