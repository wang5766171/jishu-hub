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
});
