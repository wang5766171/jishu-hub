import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanningProgressOverlay } from "./planning-progress";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("planning progress overlay", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
  });

  it("displays the current planning stage and shared steer input", () => {
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

    expect(
      screen.getByText(i18n.t("tasks.workbench.planningProgress.stages.validating")),
    ).toBeDefined();
    expect(
      screen.getByPlaceholderText(i18n.t("tasks.workbench.planningProgress.steerPlaceholder")),
    ).toBeDefined();
  });

  it("renders agent text output through the shared message view", () => {
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

  it("stops the current planner turn through the shared chat input", async () => {
    render(
      <PlanningProgressOverlay
        progress={{
          graph_id: "graph_1",
          stage: "generating",
          attempt: 1,
          max_attempts: 2,
        }}
        turnActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: i18n.t("sessions.stop") }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("orchestrator_stop_planner_turn");
    });
  });
});
