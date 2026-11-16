import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useModelPicker } from "./use-model-picker";

// mock invokeCommand：options 返回聚合形态，get_active 返回当前模型
const calls: string[] = [];
// P2-10 测试开关：set_active 可注入失败（乐观回滚断言用）。
const failSetActive = { active: false };
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
      if (failSetActive.active) throw new Error("set_active boom");
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

  it("pending- 临时会话不写会话锁，回落全局（评审 P2-7）", async () => {
    calls.length = 0;
    const { result } = renderHook(() => useModelPicker("jishu-self", true, undefined, "pending-42"));
    await waitFor(() => expect(result.current.options).toHaveLength(2));
    await result.current.select("zhipu/flash");
    await waitFor(() => expect(result.current.activeValue).toBe("zhipu/flash"));
    expect(calls).toContain("set_active");
    expect(calls).not.toContain("session_model_set");
  });

  it("写入失败回滚乐观显示值（评审 P2-10）", async () => {
    const { result } = renderHook(() => useModelPicker("jishu-self", true));
    await waitFor(() => expect(result.current.options).toHaveLength(2));
    failSetActive.active = true;
    await result.current.select("zhipu/flash");
    await waitFor(() => expect(result.current.activeValue).toBe("zhipu/glm-5.3"));
    failSetActive.active = false;
  });
});
