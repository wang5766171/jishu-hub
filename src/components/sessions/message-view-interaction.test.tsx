import i18n from "@/i18n";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import type { Message } from "@/types";
import { MessageView } from "./message-view";

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

    fireEvent.click(cards[0]);
    const card = cards[0].closest("div");
    expect(card).not.toBeNull();
    const scope = within(card as HTMLElement);

    expect(scope.getAllByText("Question 1")).toHaveLength(1);
    expect(scope.getAllByText("Question 2")).toHaveLength(1);
    expect(scope.getAllByText("Answer 2")).toHaveLength(1);
  });
});
