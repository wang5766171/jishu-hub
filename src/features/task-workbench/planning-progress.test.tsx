import i18n from "@/i18n";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { PlanningProgressOverlay } from "./planning-progress";

describe("planning progress overlay", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("blocks task changes and displays the current real planning stage", () => {
    render(
      <PlanningProgressOverlay
        progress={{
          graph_id: "graph_1",
          stage: "validating",
          attempt: 1,
          max_attempts: 2,
        }}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveTextContent("校验任务图");
    expect(dialog).toHaveTextContent("生成期间任务图已锁定");
  });
});
