/**
 * 菜单页通道单测（第四轮评审修复轮新增——二十二轮新通道此前零测试）。
 * 一次性消费语义：请求 → 宿主读到 → consume 清空；重复点击 seq 递增仍驱动。
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { consumeMenuPage, requestMenuPage, useMenuPageRequest } from "./menu-page";

describe("menu-page 通道", () => {
  it("请求 → 订阅方读到 → 消费后清空（一次性语义）", () => {
    const { result } = renderHook(() => useMenuPageRequest());
    expect(result.current).toBeNull();
    act(() => {
      requestMenuPage("session.demo");
    });
    expect(result.current).toEqual({ pluginId: "session.demo", seq: expect.any(Number) });
    act(() => {
      consumeMenuPage();
    });
    expect(result.current).toBeNull();
  });

  it("同一插件重复点击：seq 自增仍驱动消费（再入口）", () => {
    const { result } = renderHook(() => useMenuPageRequest());
    act(() => {
      requestMenuPage("session.demo");
      consumeMenuPage();
      requestMenuPage("session.demo");
    });
    const first = result.current;
    expect(first?.pluginId).toBe("session.demo");
    act(() => {
      requestMenuPage("session.demo");
    });
    expect(result.current?.seq).toBeGreaterThan(first!.seq);
    act(() => {
      consumeMenuPage();
    });
  });
});
