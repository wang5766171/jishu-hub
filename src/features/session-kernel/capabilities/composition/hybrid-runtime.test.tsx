import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import {
  HybridErrorBoundary,
  PLUGIN_API_VERSION,
  clearLibraryScriptCacheForTest,
  ensureGlobalRegisterForTest,
  loadHybridComponent,
  setAssetUrlBuilderForTest,
  setLibraryScriptInjectorForTest,
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

describe("loadAsset 与崩溃兜底（需求14 M1：02 §3.2 / B1 / B3）", () => {
  const FILES: Record<string, string> = {
    "component.js": "fp1",
    "echarts.min.js": "abc12345",
    "b.js": "dead0000",
  };

  function apiCaptureFactory(
    captured: { loadAsset?: (rel: string, kind?: "script" | "style" | "url") => Promise<string> },
  ): HybridPluginFactory {
    return {
      version: PLUGIN_API_VERSION,
      component: (api) => {
        captured.loadAsset = api.loadAsset;
        return () => null;
      },
    };
  }

  async function loadWithFiles(
    pluginId: string,
    factory: HybridPluginFactory,
    files?: Record<string, string>,
  ): Promise<void> {
    const pending = loadHybridComponent(pluginId, "C:/plugs/x", "component.js", "fp1", files);
    (globalThis as unknown as { JishuPlugin: { register(id: string, f: unknown): void } }).JishuPlugin.register(pluginId, factory);
    const result = await pending;
    expect(result).not.toBeInstanceOf(Error);
  }

  beforeEach(() => {
    ensureGlobalRegisterForTest();
    clearLibraryScriptCacheForTest();
  });
  afterEach(() => {
    document.head.querySelectorAll("script[src*='asset.localhost']").forEach((el) => el.remove());
  });

  it("url 类：返回带内容指纹的 asset URL；白名单外/越界/子目录路径拒绝（B3 平铺约束）", async () => {
    const captured: { loadAsset?: (rel: string, kind?: "script" | "style" | "url") => Promise<string> } = {};
    await loadWithFiles("p.asset-url", apiCaptureFactory(captured), FILES);
    expect(captured.loadAsset).toBeTypeOf("function");
    await expect(captured.loadAsset!("echarts.min.js")).resolves.toBe(
      "http://asset.localhost/C:/plugs/x/echarts.min.js?v=abc12345",
    );
    await expect(captured.loadAsset!("nope.js")).rejects.toThrow("不在插件文件清单");
    await expect(captured.loadAsset!("../evil.js")).rejects.toThrow("非法资产路径");
    await expect(captured.loadAsset!("/abs.js")).rejects.toThrow("非法资产路径");
    // 子目录形态不在浅层 _files 清单内——平铺约束的可观测面。
    await expect(captured.loadAsset!("sub/echarts.min.js")).rejects.toThrow("不在插件文件清单");
  });

  it("script 类：模块级缓存——同资产两次加载只注入一次（R4 性能语义）", async () => {
    const calls: string[] = [];
    setLibraryScriptInjectorForTest(async (url) => {
      calls.push(url);
    });
    const captured: { loadAsset?: (rel: string, kind?: "script" | "style" | "url") => Promise<string> } = {};
    await loadWithFiles("p.asset-script", apiCaptureFactory(captured), FILES);
    await captured.loadAsset!("echarts.min.js", "script");
    await captured.loadAsset!("echarts.min.js", "script");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("echarts.min.js?v=abc12345");
  });

  it("script 类失败不缓存（可重试）", async () => {
    let fail = true;
    setLibraryScriptInjectorForTest(async () => {
      if (fail) throw new Error("net down");
    });
    const captured: { loadAsset?: (rel: string, kind?: "script" | "style" | "url") => Promise<string> } = {};
    await loadWithFiles("p.asset-retry", apiCaptureFactory(captured), FILES);
    await expect(captured.loadAsset!("b.js", "script")).rejects.toThrow("net down");
    fail = false;
    await expect(captured.loadAsset!("b.js", "script")).resolves.toContain("b.js");
  });

  it("无 files 白名单（旧调用形态）→ api 不注入 loadAsset（纯加法不破坏旧件）", async () => {
    const captured: { loadAsset?: (rel: string, kind?: "script" | "style" | "url") => Promise<string> } = {};
    await loadWithFiles("p.asset-nofiles", apiCaptureFactory(captured), undefined);
    expect(captured.loadAsset).toBeUndefined();
  });

  it("崩溃兜底（B1）：声明 fallback 的边界渲染兜底节点；未声明维持崩溃即卸载", () => {
    const onError = vi.fn();
    setHybridErrorHandler(onError);
    function Boom(): null {
      throw new Error("插件炸了");
    }
    // createElement 三参形态在严格 tsc 下要求 props 携 children——测试内
    // 以类型断言放宽（组件运行时契约不变）。
    const Boundary = HybridErrorBoundary as unknown as (
      props: { pluginId: string; children?: ReactNode; fallback?: ReactNode },
    ) => ReactNode;
    const { container: withFallback } = render(
      createElement(Boundary as never, {
        pluginId: "p.fb",
        fallback: createElement("pre", null, "SOURCE"),
        children: createElement(Boom),
      }),
    );
    expect(withFallback.textContent).toBe("SOURCE");
    expect(onError).toHaveBeenCalledWith("p.fb", expect.any(Error));

    const { container: withoutFallback } = render(
      createElement(Boundary as never, {
        pluginId: "p.nofb",
        children: createElement(Boom),
      }),
    );
    expect(withoutFallback.textContent).toBe("");
  });
});
