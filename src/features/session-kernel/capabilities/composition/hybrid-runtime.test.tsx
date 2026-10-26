import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import {
  HybridErrorBoundary,
  PLUGIN_API_VERSION,
  ensureGlobalRegisterForTest,
  loadHybridComponent,
  setAssetUrlBuilderForTest,
  setScriptInjectorForTest,
  setHybridErrorHandler,
  validateFactory,
  type HybridPluginFactory,
} from "./hybrid-runtime";

setAssetUrlBuilderForTest((dir, rel) => `http://asset.localhost/${dir}/${rel}`);
// jsdom 对外联脚本立即 onerror（资源加载关闭），用替身注入器隔离该行为。
const injectedUrls: string[] = [];
setScriptInjectorForTest((url, onerror) => {
  injectedUrls.push(url);
  const script = document.createElement("script");
  script.src = url;
  script.dataset.hybridStub = "1";
  document.head.appendChild(script);
  void onerror;
});

const validFactory: HybridPluginFactory = {
  version: PLUGIN_API_VERSION,
  component: ({ h }) => function HybridHello({ label }: { label?: string }) {
    return h("span", null, `hello ${label ?? "world"}`);
  },
};

function injectedScriptCount(): number {
  return document.head.querySelectorAll("script[data-hybrid-stub]").length;
}

describe("混合插件运行时（需求25 P1）", () => {
  beforeEach(() => {
    ensureGlobalRegisterForTest();
  });
  afterEach(() => {
    document.head.querySelectorAll("script[src*='asset.localhost']").forEach((el) => el.remove());
    setHybridErrorHandler(() => undefined);
    vi.useRealTimers();
  });

  it("factory 契约：版本不匹配/组件非函数给明确错误，合法为 null", () => {
    expect(validateFactory("p", { version: 99, component: () => () => null } as unknown as HybridPluginFactory))
      .toContain("API 版本不匹配");
    expect(validateFactory("p", { version: 1, component: "x" as unknown as HybridPluginFactory["component"] }))
      .toContain("component 不是函数");
    expect(validateFactory("p", validFactory)).toBeNull();
  });

  it("注册链路：script 注入后 JishuPlugin.register 解析出可用组件", async () => {
    const pending = loadHybridComponent("p.ok", "C:/plugs/p.ok", "component.js", "abc12345");
    (globalThis as unknown as { JishuPlugin: { register(id: string, f: unknown): void } }).JishuPlugin.register("p.ok", validFactory);
    const component = await pending;
    expect(component).not.toBeInstanceOf(Error);
    const Comp = component as (props: { label?: string }) => ReturnType<typeof createElement>;
    const { container } = render(createElement(Comp, { label: "hub" }));
    expect(container.textContent).toBe("hello hub");
  });

  it("超时与加载失败：2 秒未注册 → 明确 Error（文件/语法/未注册提示）", async () => {
    vi.useFakeTimers();
    const pending = loadHybridComponent("p.timeout", "C:/plugs/p.timeout", "component.js", "abc12345");
    vi.advanceTimersByTime(2100);
    const result = await pending;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("JishuPlugin.register");
  });

  it("指纹缓存：同指纹重复装载不重注入 script；指纹变化重注入", async () => {
    const first = loadHybridComponent("p.cache", "C:/plugs/p.cache", "component.js", "fp1");
    (globalThis as unknown as { JishuPlugin: { register(id: string, f: unknown): void } }).JishuPlugin.register("p.cache", validFactory);
    await first;
    const scriptsAfterFirst = injectedScriptCount();
    const second = loadHybridComponent("p.cache", "C:/plugs/p.cache", "component.js", "fp1");
    const comp = await second;
    expect(comp).not.toBeInstanceOf(Error);
    expect(injectedScriptCount()).toBe(scriptsAfterFirst);
    const third = loadHybridComponent("p.cache", "C:/plugs/p.cache", "component.js", "fp2");
    (globalThis as unknown as { JishuPlugin: { register(id: string, f: unknown): void } }).JishuPlugin.register("p.cache", validFactory);
    await third;
    expect(injectedScriptCount()).toBe(scriptsAfterFirst + 1);
  });

  it("崩溃隔离：组件抛错 → 渲染为 null 且错误回调触发", () => {
    const onError = vi.fn();
    setHybridErrorHandler(onError);
    function Boom(): null {
      throw new Error("插件炸了");
    }
    const { container } = render(
      createElement(HybridErrorBoundary, { pluginId: "p.boom", children: createElement(Boom) }),
    );
    expect(container.textContent).toBe("");
    expect(onError).toHaveBeenCalledWith("p.boom", expect.any(Error));
  });
});
