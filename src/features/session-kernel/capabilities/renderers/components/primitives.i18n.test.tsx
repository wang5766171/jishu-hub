/**
 * v0.9.8 评审修复轮 R2 / M-6：内置渲染原语里给人看的提示文字走词典。
 * 此前两处写死中文（工具返回值不是表格时的说明、图片的替代文字），英文界面下照出中文。
 */
import i18n from "@/i18n";
import type React from "react";
import { render } from "@testing-library/react";
import { afterAll, describe, expect, it } from "vitest";
import "@/features/session-kernel/capabilities/renderers/components/primitives";
import { rendererRegistry } from "../registry";

describe("内置渲染原语 · 提示文字随界面语言", () => {
  afterAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("M6-3 英文界面下工具返回值渲染件的提示文字是英文", async () => {
    await i18n.changeLanguage("en");
    const pick = (key: string) =>
      rendererRegistry.get(key)!.component as unknown as React.ComponentType<{ payload: unknown }>;
    const Table = pick("render.table");
    const notTable = render(<Table payload={{ kind: "tool-result", output: "不是表格" }} />);
    expect(notTable.container.textContent).toBe("Not a table (JSON needs columns + rows)");

    const Image = pick("render.image");
    const picture = render(<Image payload={{ kind: "tool-result", output: "data:image/png;base64,AAAA" }} />);
    expect(picture.container.querySelector("img")?.alt).toBe("Tool image output");

    await i18n.changeLanguage("zh");
    const zh = render(<Table payload={{ kind: "tool-result", output: "不是表格" }} />);
    expect(zh.container.textContent).toBe("非表格 JSON（需含 columns + rows）");
  });
});
