import "@testing-library/jest-dom";
// 三轮评审 P1-5/6 配套：i18n 全量初始化（组件文案走 i18n 后，测试渲染
// 需要真实词表）；固定 zh——UI 断言基于中文文案，语言检测在 jsdom 环境
// （navigator.language=en-US）会翻成英文导致断言不稳。
import "@/i18n";
import i18n from "@/i18n";
void i18n.changeLanguage("zh");

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
  // SAFETY: ResizeObserverStub 与 ResizeObserver 接口同构（全部方法 no-op/
  // 构造器收回调）——jsdom 未实现该浏览器 API，运行时无真实调用方可区分。
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
