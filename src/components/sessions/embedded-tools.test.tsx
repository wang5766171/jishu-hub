import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserTextWithPills, EmbeddedToolPills } from "./embedded-tools";

/**
 * v0.9.0 需求3 方案 C 契约锁定：pill 数据源为 toolIds 元数据参数，组件
 * 零文本解析（[JISHU-TOOLS] 文本标记方案已按版本级裁决整体废弃）。
 * 文本标记解析的后端等价契约见 src-tauri chat_tests / tool_plugin tests
 * 的 extract_tool_snapshot（回放派生）。
 */

describe("UserTextWithPills（M7 → v0.9.0 需求3：元数据契约）", () => {
  it("toolIds 非空时按映射渲染 pill 与正文（零文本解析）", () => {
    render(
      <UserTextWithPills
        text="列出我的仓库"
        toolIds={["gh-cli", "task-plan"]}
        toolNames={{ "gh-cli": "GitHub", "task-plan": "方案规划" }}
      />,
    );
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("方案规划")).toBeTruthy();
    expect(screen.getByText("列出我的仓库")).toBeTruthy();
  });

  it("toolIds 为空时只渲染正文", () => {
    render(<UserTextWithPills text="普通消息" toolIds={[]} toolNames={{}} />);
    expect(screen.getByText("普通消息")).toBeTruthy();
  });

  it("正文原样渲染——不剥任何前缀（标记机制已删除）", () => {
    render(
      <UserTextWithPills
        text="[JISHU-TOOLS:a] 字面输入不防御（版本级裁决）"
        toolIds={[]}
        toolNames={{}}
      />,
    );
    // 无 toolIds 元数据时正文一字不改（含字面标记形态的文本也不做解析）。
    expect(
      screen.getByText("[JISHU-TOOLS:a] 字面输入不防御（版本级裁决）"),
    ).toBeTruthy();
  });

  it("未知 id 回退显示英文 id（名称映射缺失容错）", () => {
    render(
      <EmbeddedToolPills toolIds={["unknown-x"]} toolNames={{}} />,
    );
    expect(screen.getByText("unknown-x")).toBeTruthy();
  });
});
