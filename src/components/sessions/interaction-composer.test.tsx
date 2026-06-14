import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ConversationInteractionRequest } from "@/types";
import { InteractionComposer } from "./interaction-composer";

const singleChoiceRequest: ConversationInteractionRequest = {
  requestId: "req-regular-1",
  prompt: "请选择实施顺序",
  options: [
    { optionId: "frontend", label: "前端优先" },
    { optionId: "backend", label: "后端优先", description: "先完成接口与权限模型" },
    { optionId: "parallel", label: "前后端并行" },
  ],
  allowMultiple: false,
  allowCustomText: true,
  required: true,
};

describe("InteractionComposer", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("submits the selected option and optional text", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <InteractionComposer
        request={singleChoiceRequest}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /后端优先/ }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "优先完成组织数据权限" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交选择" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        requestId: "req-regular-1",
        selectedOptionIds: ["backend"],
        customText: "优先完成组织数据权限",
      });
    });
  });

  it("replaces the previous selection for a single-choice request", () => {
    render(
      <InteractionComposer
        request={singleChoiceRequest}
        onSubmit={vi.fn()}
      />,
    );

    const frontend = screen.getByRole("button", { name: /前端优先/ });
    const backend = screen.getByRole("button", { name: /后端优先/ });
    fireEvent.click(frontend);
    fireEvent.click(backend);

    expect(frontend).toHaveAttribute("aria-pressed", "false");
    expect(backend).toHaveAttribute("aria-pressed", "true");
  });

  it("supports multiple selections when requested", () => {
    render(
      <InteractionComposer
        request={{ ...singleChoiceRequest, requestId: "req-multi", allowMultiple: true }}
        onSubmit={vi.fn()}
      />,
    );

    const frontend = screen.getByRole("button", { name: /前端优先/ });
    const backend = screen.getByRole("button", { name: /后端优先/ });
    fireEvent.click(frontend);
    fireEvent.click(backend);

    expect(frontend).toHaveAttribute("aria-pressed", "true");
    expect(backend).toHaveAttribute("aria-pressed", "true");
  });

  it("does not render a custom text box when the request forbids it", () => {
    render(
      <InteractionComposer
        request={{ ...singleChoiceRequest, allowCustomText: false }}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
