import i18n from "@/i18n";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { InteractionCard } from "./interaction-card";

describe("InteractionCard", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("dedupes repeated question and answer items in an expanded card", () => {
    render(
      <InteractionCard
        defaultOpen
        origin="acp_elicitation"
        items={[
          { prompt: "Question 1", answer: "A", options: [] },
          { prompt: "Question 2", answer: "B", options: [] },
          { prompt: "Question 2", answer: "B", options: [] },
        ]}
      />,
    );

    expect(screen.getAllByText("Question 1")).toHaveLength(1);
    expect(screen.getAllByText("Question 2")).toHaveLength(1);
    expect(screen.getAllByText("B")).toHaveLength(1);
  });

  it("v0.9.4 需求11：卡内不再渲染 agent 来源徽标（原「内置/外部助手」文案废弃）", () => {
    render(
      <InteractionCard
        defaultOpen
        origin="acp_elicitation"
        items={[{ prompt: "Question", answer: "Answer", options: [] }]}
      />,
    );

    expect(screen.queryByText("External assistant")).not.toBeInTheDocument();
    expect(screen.queryByText("Built-in assistant")).not.toBeInTheDocument();
    expect(screen.getByText("Question")).toBeInTheDocument();
  });
});
