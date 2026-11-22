import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserTextWithPills, EmbeddedToolPill, EmbeddedToolPills } from "./embedded-tools";

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

  it("U2a（v0.9.8 需求9-② 方案 B）：pill 渲染在正文之后，不再前置", () => {
    const { container } = render(
      <UserTextWithPills
        text="正文在前"
        toolIds={["gh-cli"]}
        toolNames={{ "gh-cli": "GitHub" }}
      />,
    );
    const host = container.querySelector("span.whitespace-pre-wrap");
    expect(host).toBeTruthy();
    if (!host) return;
    // DOM 序列断言：正文文本节点先于 pill（原「pill 恒前置」误导用户实测 #3）
    const children = [...host.childNodes];
    const textIdx = children.findIndex((n) => n.textContent === "正文在前");
    const pillIdx = children.findIndex((n) => (n.textContent || "").includes("GitHub"));
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(pillIdx).toBeGreaterThan(textIdx);
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

  it("需求7 补充：pill 图标按类型区分（与 + 菜单同款映射）", () => {
    const { container, rerender } = render(
      <EmbeddedToolPill name="写后诊断" kind="skill" />,
    );
    expect(container.querySelector("svg.lucide-sparkles")).toBeTruthy();
    rerender(<EmbeddedToolPill name="联网搜索" kind="extension" />);
    expect(container.querySelector("svg.lucide-package")).toBeTruthy();
    rerender(<EmbeddedToolPill name="文档服务" kind="mcp" />);
    expect(container.querySelector("svg.lucide-server")).toBeTruthy();
    // 缺省/未知 kind → Blocks（兼容既有形态）。
    rerender(<EmbeddedToolPill name="流程规划" />);
    expect(container.querySelector("svg.lucide-blocks")).toBeTruthy();
  });

  it("需求7 补充：EmbeddedToolPills 组随 toolCats 出对应图标", () => {
    const { container } = render(
      <EmbeddedToolPills
        toolIds={["s1", "e1"]}
        toolNames={{ s1: "技能件", e1: "扩展件" }}
        toolCats={{ s1: "skill", e1: "extension" }}
      />,
    );
    expect(container.querySelector("svg.lucide-sparkles")).toBeTruthy();
    expect(container.querySelector("svg.lucide-package")).toBeTruthy();
  });
});
