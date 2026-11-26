/** 需求12 P1：配置面纯函数——defaults 合并 / section 展平 / diff 校验（clamp/差异落盘语义）。
 *  v0.9.8 评审修复轮 R2 / M-4：另含缓存订阅（usePluginConfig）的首载通知与失效重拉。 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetConfigCacheForTest,
  diffAgainstDefaults,
  flattenSchema,
  getPluginConfig,
  mergeConfig,
  setPluginConfig,
  usePluginConfig,
} from "./config-plane";
import type { PluginConfigField } from "./config-plane";

const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));

const listenMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

const SCHEMA: PluginConfigField[] = [
  {
    key: "display",
    type: "section",
    label: "显示",
    fields: [
      { key: "inlineScalePct", type: "number", label: "初始缩放", default: 50, min: 10, max: 100, unit: "%" },
      { key: "themeFollow", type: "switch", label: "主题跟随", default: true },
    ],
  },
  { key: "pngScale", type: "number", label: "PNG 倍率", default: 2, min: 1, max: 4 },
  { key: "quietHours", type: "text", label: "静音时段", default: "", placeholder: "HH:mm-HH:mm" },
];

describe("config-plane", () => {
  it("merges user values over defaults (section flattened)", () => {
    const values = mergeConfig(SCHEMA, { inlineScalePct: 80 });
    expect(values).toEqual({ inlineScalePct: 80, themeFollow: true, pngScale: 2, quietHours: "" });
  });

  it("flattenSchema skips sections, keeps order", () => {
    const flat = flattenSchema(SCHEMA);
    expect(flat.map((f) => f.key)).toEqual(["inlineScalePct", "themeFollow", "pngScale", "quietHours"]);
  });

  it("diff keeps only explicit non-default keys", () => {
    const diff = diffAgainstDefaults(SCHEMA, { inlineScalePct: 80, themeFollow: true, pngScale: 2 });
    expect(diff).toEqual({ inlineScalePct: 80 });
  });

  it("diff clamps numbers to schema bounds", () => {
    const diff = diffAgainstDefaults(SCHEMA, { pngScale: 99 });
    expect(diff).toEqual({ pngScale: 4 });
  });

  it("diff drops invalid numbers instead of writing NaN", () => {
    const diff = diffAgainstDefaults(SCHEMA, { pngScale: Number.NaN });
    expect(diff).toEqual({});
  });
});

describe("config-plane · 缓存订阅（usePluginConfig）", () => {
  const ONE: PluginConfigField[] = [{ key: "k", type: "number", label: "K", default: 0 }];

  /** 取到 plugins-config-changed 的监听回调（ensureListening 经动态 import 异步注册，
   *  每个模块只注册一次——回调跨用例仍指向同一份模块态，这里不清它的调用记录）。 */
  const changeHandler = async () => {
    await waitFor(() => {
      expect(listenMock.mock.calls.some(([event]) => event === "plugins-config-changed")).toBe(true);
    });
    return listenMock.mock.calls.find(([event]) => event === "plugins-config-changed")![1] as (e: unknown) => void;
  };

  beforeEach(() => {
    __resetConfigCacheForTest();
    invokeCommand.mockReset();
    listenMock.mockResolvedValue(() => {});
  });

  it("M4-1 首次加载完成：组件拿到用户配置（不需要别的重渲染）", async () => {
    let resolve!: (value: unknown) => void;
    invokeCommand.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { result } = renderHook(() => usePluginConfig("p", ONE));
    // 加载中：默认值
    expect(result.current.values.k).toBe(0);
    expect(result.current.ready).toBe(false);
    await act(async () => {
      resolve({ p: { k: 1 } });
    });
    expect(result.current.values.k).toBe(1);
    expect(result.current.ready).toBe(true);
  });

  it("M4-2 收到配置变更事件：重新拉取，组件显示新值", async () => {
    let backend: unknown = { p: { k: 1 } };
    invokeCommand.mockImplementation(() => Promise.resolve(backend));
    const { result } = renderHook(() => usePluginConfig("p", ONE));
    await waitFor(() => expect(result.current.values.k).toBe(1));
    const handler = await changeHandler();
    backend = { p: { k: 2 } };
    await act(async () => {
      handler({ payload: { pluginId: "p" } });
    });
    expect(result.current.values.k).toBe(2);
    expect(invokeCommand).toHaveBeenCalledWith("plugin_config_get_all");
  });

  it("重拉回来的内容没变：不通知（本进程保存后的那次广播不触发多余重渲染）", async () => {
    let renders = 0;
    invokeCommand.mockImplementation(() => Promise.resolve({ p: { k: 1 } }));
    const { result } = renderHook(() => {
      renders += 1;
      return usePluginConfig("p", ONE);
    });
    await waitFor(() => expect(result.current.values.k).toBe(1));
    const handler = await changeHandler();
    const before = renders;
    await act(async () => {
      handler({});
    });
    expect(renders).toBe(before);
  });

  it("M4-3 首载完成前保存：先等首载，本地提交合在完整快照上（别的插件的配置不丢）", async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((r) => {
      resolveFirst = r;
    });
    invokeCommand.mockImplementation((cmd: string) =>
      cmd === "plugin_config_get_all" ? first : Promise.resolve(null),
    );
    const { result } = renderHook(() => usePluginConfig("p", ONE));
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = setPluginConfig("p", ONE, { k: 5 });
    });
    await act(async () => {
      resolveFirst({ p: { k: 1 }, other: { k: 9 } });
      await saving;
    });
    // 保存成功生效，且首载带回的别的插件配置还在缓存里
    expect(result.current.values.k).toBe(5);
    expect(getPluginConfig("other", ONE).k).toBe(9);
    expect(invokeCommand).toHaveBeenCalledWith("plugin_config_set", { pluginId: "p", values: { k: 5 } });
  });
});
