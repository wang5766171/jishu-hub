import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useModelPicker } from "./use-model-picker";

// mock invokeCommand：options 返回聚合形态，get_active 返回当前模型
const calls: string[] = [];
vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand: async (cmd: string, args: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === "get_model_picker_options") {
      return [
        {
          value: "zhipu/glm-5.3",
          label: "智谱 · glm-5.3",
          thinking_levels: ["off", "low", "medium", "high"],
          reasoning: true,
        },
        {
          value: "zhipu/flash",
          label: "智谱 · flash",
          thinking_levels: ["off"],
          reasoning: false,
        },
      ];
    }
    if (cmd === "get_active") {
      return { provider: "zhipu", model: "glm-5.3" };
    }
    if (cmd === "set_active") {
      return { provider: (args.active as { provider: string }).provider };
    }
    return null;
  },
}));


describe("use-model-picker（v0.8.0 需求3）", () => {
  it("聚合 IPC 加载 options 并派生激活模型档位", async () => {
    const { result } = renderHook(() => useModelPicker("jishu-self", true));
    await waitFor(() => {
      expect(result.current.options).toHaveLength(2);
    });
    expect(result.current.activeValue).toBe("zhipu/glm-5.3");
    expect(result.current.thinkingLevels).toEqual(["off", "low", "medium", "high"]);
    expect(result.current.reasoning).toBe(true);
    expect(result.current.labelFor("zhipu/glm-5.3")).toBe("智谱 · glm-5.3");
  });

  it("禁用（非 model-store surface）时清空不取数", async () => {
    calls.length = 0;
    const { result } = renderHook(() => useModelPicker("codex", false));
    expect(result.current.options).toEqual([]);
    expect(result.current.activeValue).toBeNull();
    expect(result.current.thinkingLevels).toEqual([
      "off", "minimal", "low", "medium", "high",
    ]);
  });

  it("选择经 set_active 写入并更新激活值", async () => {
    const { result } = renderHook(() => useModelPicker("jishu-self", true));
    await waitFor(() => expect(result.current.options).toHaveLength(2));
    await result.current.select("zhipu/flash");
    await waitFor(() => {
      expect(result.current.activeValue).toBe("zhipu/flash");
      expect(result.current.thinkingLevels).toEqual(["off"]);
      expect(result.current.reasoning).toBe(false);
    });
  });
});
