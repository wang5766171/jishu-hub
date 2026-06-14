import i18n from "@/i18n";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { PlanningProgressOverlay } from "./planning-progress";

describe("planning progress overlay", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("displays the current planning stage and steer input", () => {
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

    // Stage label is visible.
    expect(screen.getByText("校验任务图")).toBeDefined();
    // Steer input exists.
    expect(
      screen.getByPlaceholderText("输入引导内容，Agent 会在当前规划中综合考虑…"),
    ).toBeDefined();
  });

  it("renders agent text output with markdown", () => {
    render(
      <PlanningProgressOverlay
        progress={{
          graph_id: "graph_1",
          stage: "generating",
          attempt: 1,
          max_attempts: 2,
        }}
        text="正在分析项目结构..."
      />,
    );

    expect(screen.getByText("正在分析项目结构...")).toBeDefined();
  });
});
