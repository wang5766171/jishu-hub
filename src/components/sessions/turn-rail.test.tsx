import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Message } from "@/types";
import { MessageView } from "./message-view";
import { TurnRail, buildTurnSummaries } from "./turn-rail";

// MessageView 渲染 tool_use 块时经 ToolCallCard 依赖 FileViewer 上下文，
// 单测无 Provider——mock 掉（本测试只关心 data-turn-index 序号）。
vi.mock("@/components/file-viewer", () => ({
  useFileViewer: () => ({ openViewer: vi.fn() }),
}));

function textMsg(role: string, text: string): Message {
  return { role, timestamp: null, content: [{ type: "text", text }] };
}

function toolResultUserMsg(): Message {
  return {
    role: "user",
    timestamp: null,
    content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
  };
}

describe("buildTurnSummaries", () => {
  it("derives one turn per user message with the first assistant text as answer", () => {
    const messages: Message[] = [
      textMsg("user", "第一问"),
      textMsg("assistant", "第一答开头"),
      textMsg("assistant", "第一答后续"),
      textMsg("user", "第二问"),
      textMsg("assistant", "第二答"),
    ];
    expect(buildTurnSummaries(messages)).toEqual([
      { question: "第一问", answer: "第一答开头" },
      { question: "第二问", answer: "第二答" },
    ]);
  });

  it("merges tool-result-only user messages into the running turn", () => {
    const messages: Message[] = [
      textMsg("user", "跑一下构建"),
      { role: "assistant", timestamp: null, content: [{ type: "tool_use", id: "t1", name: "shell", input: {} }] },
      toolResultUserMsg(),
      textMsg("assistant", "构建通过"),
    ];
    expect(buildTurnSummaries(messages)).toEqual([
      { question: "跑一下构建", answer: "构建通过" },
    ]);
  });

  it("keeps a tool-result-only user message as its own turn when no assistant precedes it", () => {
    const summaries = buildTurnSummaries([toolResultUserMsg(), textMsg("assistant", "答")]);
    expect(summaries).toEqual([{ question: "", answer: "答" }]);
  });

  it("joins multiple text blocks of the user message and keeps answer empty when absent", () => {
    const user: Message = {
      role: "user",
      timestamp: null,
      content: [
        { type: "text", text: "上半" },
        { type: "tool_use", id: "u1", name: "grep", input: {} },
        { type: "text", text: "下半" },
      ],
    };
    const summaries = buildTurnSummaries([user, { role: "assistant", timestamp: null, content: [{ type: "tool_use", id: "a1", name: "read", input: {} }] }]);
    expect(summaries).toEqual([{ question: "上半\n下半", answer: "" }]);
  });
});

describe("TurnRail", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  const turns = [
    { question: "问题一", answer: "回答一" },
    { question: "问题二", answer: "" },
    { question: "", answer: "回答三" },
  ];

  it("renders one bar per turn and returns the index on click", () => {
    const onJump = vi.fn();
    render(<TurnRail turns={turns} activeIndex={0} onJump={onJump} />);
    const bars = screen.getAllByRole("button");
    expect(bars).toHaveLength(3);
    expect(bars[2].getAttribute("aria-label")).toContain("3");
    fireEvent.click(bars[2]);
    expect(onJump).toHaveBeenCalledWith(2);
  });

  it("shows a hover preview with question (2-line clamp) and answer (3-line clamp)", () => {
    render(<TurnRail turns={turns} activeIndex={0} onJump={vi.fn()} />);
    fireEvent.mouseEnter(screen.getAllByRole("button")[0]);
    expect(screen.getByText("问题一")).toBeTruthy();
    expect(screen.getByText("回答一")).toBeTruthy();
    const question = screen.getByText("问题一");
    expect(question.className).toContain("line-clamp-2");
    const answer = screen.getByText("回答一");
    expect(answer.className).toContain("line-clamp-3");
    // 预览收起挂在横杠列容器（mouseleave 整列），单条横杠离开不收起——
    // 鼠标滑过横杠间隙时波浪与卡片不闪烁。
    const barsColumn = screen.getAllByRole("button")[0].parentElement as HTMLElement;
    fireEvent.mouseLeave(barsColumn);
    expect(screen.queryByText("问题一")).toBeNull();
  });

  it("waves bar widths by distance from the hovered bar and recolors it", () => {
    render(<TurnRail turns={turns} activeIndex={0} onJump={vi.fn()} />);
    const bars = screen.getAllByRole("button");
    const barSpan = (i: number) => bars[i].querySelector("span") as HTMLElement;
    // 未悬停：活动轮 w-4 高亮色，其余基础档 w-2
    expect(barSpan(0).className).toContain("w-4");
    expect(barSpan(1).className).toContain("w-2");
    fireEvent.mouseEnter(bars[1]);
    // 悬停轮最长 w-5 且换悬停色；d=1 → w-4
    expect(barSpan(1).className).toContain("w-5");
    expect(barSpan(1).className).toContain("bg-muted-foreground");
    expect(barSpan(0).className).toContain("w-4");
    expect(barSpan(2).className).toContain("w-4");
    expect(barSpan(0).className).toContain("bg-foreground/80");
    // 活动轮保持高亮色，长度跟随波浪；d=2 → w-3.5
    fireEvent.mouseEnter(bars[2]);
    expect(barSpan(2).className).toContain("w-5");
    expect(barSpan(1).className).toContain("w-4");
    expect(barSpan(0).className).toContain("w-3.5");
    // 鼠标离开整列：波浪收起，活动轮回 w-4
    fireEvent.mouseLeave(bars[0].parentElement as HTMLElement);
    expect(barSpan(2).className).toContain("w-2");
    expect(barSpan(0).className).toContain("w-4");
  });

  it("falls back to a placeholder for empty question/answer text", () => {
    render(<TurnRail turns={turns} activeIndex={0} onJump={vi.fn()} />);
    fireEvent.mouseEnter(screen.getAllByRole("button")[1]);
    expect(screen.getAllByText("(no text)").length).toBeGreaterThan(0);
  });

  it("highlights the active turn bar", () => {
    render(<TurnRail turns={turns} activeIndex={1} onJump={vi.fn()} />);
    const bars = screen.getAllByRole("button");
    const activeBar = bars[1].querySelector("span");
    const idleBar = bars[0].querySelector("span");
    expect(activeBar?.className).toContain("bg-foreground/80");
    expect(activeBar?.className).toContain("w-4");
    expect(idleBar?.className).toContain("bg-border");
    expect(idleBar?.className).toContain("w-2");
  });

  it("renders nothing without turns", () => {
    const { container } = render(<TurnRail turns={[]} activeIndex={0} onJump={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("MessageView data-turn-index（横杠与用户行对齐）", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("numbers user rows sequentially and skips merged tool-result-only user messages", () => {
    const messages: Message[] = [
      textMsg("user", "第一问"),
      textMsg("assistant", "第一答"),
      { role: "assistant", timestamp: null, content: [{ type: "tool_use", id: "t1", name: "shell", input: {} }] },
      toolResultUserMsg(),
      textMsg("user", "第二问"),
      textMsg("assistant", "第二答"),
    ];
    // 横杠数据与 DOM 行必须给出同样的轮次数与顺序
    const summaries = buildTurnSummaries(messages);
    expect(summaries).toHaveLength(2);

    const { container } = render(<MessageView messages={messages} flat />);
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-turn-index]"));
    expect(rows.map((el) => el.getAttribute("data-turn-index"))).toEqual(["0", "1"]);
    // 两条 user 行仍带既有标记（搜索/流式依赖），tool_result 行不占行
    expect(container.querySelectorAll('[data-user-message="true"]')).toHaveLength(2);
  });
});
