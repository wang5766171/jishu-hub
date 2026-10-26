import i18n from "@/i18n";
import { render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Message } from "@/types";
import { MessageView } from "./message-view";

// MessageView 渲染 tool_use 块时经 ToolCallCard 依赖 FileViewer 上下文，
// 单测无 Provider——mock 掉（同 turn-rail.test.tsx）。
vi.mock("@/components/file-viewer", () => ({
  useFileViewer: () => ({ openViewer: vi.fn() }),
}));

describe("MessageView interaction rendering", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("groups consecutive persisted interactions without duplicating repeated items", async () => {
    const messages: Message[] = [
      {
        role: "assistant",
        timestamp: null,
        content: [
          { type: "text", text: "Intro" },
          {
            type: "interaction",
            prompt: "Question 1",
            answer: "Answer 1",
            options: [],
            origin: "acp_elicitation",
          },
          {
            type: "interaction",
            prompt: "Question 2",
            answer: "Answer 2",
            options: [],
            origin: "acp_elicitation",
          },
          {
            type: "interaction",
            prompt: "Question 2",
            answer: "Answer 2",
            options: [],
            origin: "acp_elicitation",
          },
          { type: "text", text: "Done" },
        ],
      },
    ];

    render(<MessageView messages={messages} flat />);

    const cards = screen.getAllByRole("button", { name: /Ask user/i });
    expect(cards).toHaveLength(1);

    // v0.9.4 需求11：回放卡默认展开（保留选项）——无需点击即见内容。
    const card = cards[0].closest("div");
    expect(card).not.toBeNull();
    const scope = within(card as HTMLElement);

    expect(scope.getAllByText("Question 1")).toHaveLength(1);
    expect(scope.getAllByText("Question 2")).toHaveLength(1);
    expect(scope.getAllByText("Answer 2")).toHaveLength(1);
  });

  it("marks user rows as scroll navigation targets", () => {
    const messages: Message[] = [
      {
        role: "user",
        timestamp: null,
        content: [{ type: "text", text: "First question" }],
      },
      {
        role: "assistant",
        timestamp: null,
        content: [{ type: "text", text: "Answer" }],
      },
    ];

    const { container } = render(<MessageView messages={messages} flat />);

    expect(container.querySelectorAll('[data-user-message="true"]')).toHaveLength(1);
  });

  it("shows an Error badge for replayed tool failures and Done for successes", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        timestamp: null,
        content: [
          { type: "tool_use", id: "call-1", name: "edit", input: { file: "a.md" } },
          { type: "tool_use", id: "call-2", name: "read", input: { file: "b.md" } },
        ],
      },
      {
        role: "user",
        timestamp: null,
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "Could not find edits[5]", is_error: true },
          { type: "tool_result", tool_use_id: "call-2", content: "ok" },
        ],
      },
    ];

    render(<MessageView messages={messages} flat />);

    // v0.9.3 测试期修复：回放按 tool_result.is_error 显示状态徽标，
    // 而非一律 success（失败 edit 被掩成 Done）。
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });
});
