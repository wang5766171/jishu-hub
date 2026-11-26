import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserTextWithPills, EmbeddedToolPill, EmbeddedToolPills } from "./embedded-tools";
import { pageText } from "./search-highlight";

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

// v0.9.8 需求9 路线甲：内联渲染（用户填入位置）+trailing 排重+编辑重扫。
describe("embedded-tools 需求9 甲（内联位置渲染）", () => {
  const names = { "dev-god": "写后诊断", "skill-a": "编程大神.Skill" } as Record<string, string>;
  const cats = { "dev-god": "cli", "skill-a": "skill" } as Record<string, string>;

  it("U9-甲1: hasKnownToolToken——命中映射才 true（未知/无字样 false）", async () => {
    const { hasKnownToolToken } = await import("./embedded-tools");
    expect(hasKnownToolToken("用 @[写后诊断] 查", names)).toBe(true);
    expect(hasKnownToolToken("@[不认识的] 查", names)).toBe(false);
    expect(hasKnownToolToken("纯文本", names)).toBe(false);
    expect(hasKnownToolToken("@[写后诊断]", undefined)).toBe(false);
  });

  it("U9-甲2: UserTextWithPills 内联命中时 trailing 排重（不双份）", () => {
    render(
      <UserTextWithPills
        text="用 @[写后诊断] 查代码"
        toolIds={["dev-god"]}
        toolNames={names}
        toolCats={cats}
      />,
    );
    // 内联 pill（data-tool-pill）恰一个；trailing pills（组渲染）不出现
    // 同名——dev-god 已被内联覆盖。
    expect(document.querySelectorAll("[data-tool-pill]").length).toBe(1);
    expect(document.body.textContent).toContain("写后诊断");
  });

  it("U9-甲3: 无字样（历史剥离消息）——trailing 照旧（toolIds 全量尾随）", () => {
    render(
      <UserTextWithPills
        text="用 写后诊断 查代码"
        toolIds={["dev-god"]}
        toolNames={names}
        toolCats={cats}
      />,
    );
    // 无内联；尾随组渲染在（EmbeddedToolPills 的 pill 无 data-tool-pill——
    // 组形态），文本原样。
    expect(document.querySelectorAll("[data-tool-pill]").length).toBe(0);
    expect(document.body.textContent).toContain("写后诊断");
  });

  it("U9-甲4: scanToolIdsFromText——从文本反扫 id（编辑提交用），未知不收", async () => {
    const { scanToolIdsFromText } = await import("./embedded-tools");
    expect(scanToolIdsFromText("用 @[写后诊断] 和 @[编程大神.Skill]", names)).toEqual(["dev-god", "skill-a"]);
    expect(scanToolIdsFromText("@[不认识的] 原样", names)).toEqual([]);
    expect(scanToolIdsFromText("无字样", names)).toEqual([]);
  });

  it("U9-甲5（二轮评审 R3 P2-4）: 两个工具显示名相同时，取清单里靠前的那个——与后端、与 extractToolTokens 同一规则", async () => {
    const { scanToolIdsFromText } = await import("./embedded-tools");
    const sameName = { first: "同名工具", second: "同名工具" } as Record<string, string>;
    // 修前：后一个覆盖前一个，反扫得到 second
    expect(scanToolIdsFromText("用 @[同名工具]", sameName)).toEqual(["first"]);
  });
});

/**
 * 标签的原始文本——v0.9.8 评审修复轮 R2（用户裁决「标签的格式可以直接搜……搜索时识别
 * 原始文本即可」），对应 tests/V-用例清单 V1-U14 / V4-U1。
 * 页面文字 = 参与搜索的文字节点拼起来的一整串（search-highlight 的 pageText），要与搜索文本
 *（blockSearchText）逐字相等。
 */
describe("标签的原始文本 @[显示名]", () => {
  const names = { "dev-god": "写后诊断", "skill-a": "方案规划", "gh-cli": "GitHub" } as Record<string, string>;
  /** 容器里只有内联级的元素（span，以及图标 svg 里的东西）——没有块级盒子。 */
  const inlineOnly = (root: Element) => [...root.querySelectorAll("*")].every((el) => el.tagName === "SPAN" || el.closest("svg") !== null);

  it("尾随标签：页面文字 = 正文 + @[显示名]；标签与正文是同一个内联容器的相邻子节点——V1-U14", () => {
    const { container } = render(<UserTextWithPills text="列出我的仓库" toolIds={["dev-god", "skill-a"]} toolNames={names} />);
    const host = container.querySelector("span.whitespace-pre-wrap");
    expect(host).toBeTruthy();
    // 正文文字节点在前，标签组紧随其后，中间没有任何节点
    const children = [...host!.childNodes];
    expect(children).toHaveLength(2);
    expect(children[0].nodeType).toBe(Node.TEXT_NODE);
    expect(children[0].textContent).toBe("列出我的仓库");
    expect(children[1].nodeName).toBe("SPAN");
    expect(inlineOnly(host!)).toBe(true);
    expect(pageText(container)).toBe("列出我的仓库@[写后诊断]@[方案规划]");
    // 看得见的还是显示名
    expect(screen.getByText("写后诊断")).toBeTruthy();
    expect(screen.getByText("方案规划")).toBeTruthy();
  });

  it("内联标签：排版用的不可见占位不参与页面文字，看得见的那份给出原始文本——V4-U1", () => {
    const { container } = render(
      <UserTextWithPills text="用 @[写后诊断] 查代码" toolIds={["dev-god"]} toolNames={names} />,
    );
    expect(container.querySelectorAll("[data-tool-pill]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-no-search]")).toHaveLength(1);
    expect(pageText(container)).toBe("用 @[写后诊断] 查代码");
    // 看得见的名字不在被排除的那一份里
    const visibleName = screen.getByText("写后诊断");
    expect(visibleName.closest("[data-no-search]")).toBeNull();
    expect(visibleName.closest("[data-tool-pill]")).not.toBeNull();
  });

  it("内联 + 没被字样覆盖到的工具：字样原位成标签，其余跟在正文之后", () => {
    const { container } = render(
      <UserTextWithPills text="用 @[方案规划] 排期" toolIds={["skill-a", "dev-god"]} toolNames={names} />,
    );
    expect(pageText(container)).toBe("用 @[方案规划] 排期@[写后诊断]");
  });

  it("名字对不上的字样按原文显示，不变成标签", () => {
    const { container } = render(<UserTextWithPills text="@[不认识的] 原样" toolIds={[]} toolNames={names} />);
    expect(container.querySelectorAll("[data-tool-pill]")).toHaveLength(0);
    expect(pageText(container)).toBe("@[不认识的] 原样");
  });

  it("显示名取不到的 id：页面文字按 @[id]", () => {
    const { container } = render(<UserTextWithPills text="正文" toolIds={["ghost"]} toolNames={{}} />);
    expect(pageText(container)).toBe("正文@[ghost]");
  });

  it("单个标签（输入框 mirror 层同款）：占位带 data-no-search，首尾的 @[ ] 不占宽度", () => {
    const { container } = render(<EmbeddedToolPill name="写后诊断" kind="skill" />);
    const placeholder = container.querySelector("[data-no-search]");
    expect(placeholder?.textContent).toBe("@[写后诊断]");
    const marks = [...container.querySelectorAll('span[aria-hidden="true"]')].filter((el) => el !== placeholder);
    expect(marks.map((el) => el.textContent)).toEqual(["@[", "]"]);
    for (const mark of marks) expect(mark.className).toContain("w-0");
    expect(pageText(container)).toBe("@[写后诊断]");
  });

  it("标签组：每个标签的页面文字是 @[显示名]", () => {
    const { container } = render(<EmbeddedToolPills toolIds={["gh-cli", "ghost"]} toolNames={names} trailing />);
    expect(pageText(container)).toBe("@[GitHub]@[ghost]");
    expect(container.querySelectorAll("[data-no-search]")).toHaveLength(0);
  });
});
