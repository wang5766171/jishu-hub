import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ConversationInteractionRequest } from "@/types";
import { InteractionComposer } from "./interaction-composer";

const singleChoiceRequest: ConversationInteractionRequest = {
  requestId: "req-regular-1",
  prompt: "Choose implementation order",
  options: [
    { optionId: "frontend", label: "Frontend first" },
    { optionId: "backend", label: "Backend first", description: "Stabilize the API and auth model" },
    { optionId: "parallel", label: "Parallel work" },
  ],
  allowMultiple: false,
  allowCustomText: true,
  required: true,
};

describe("InteractionComposer", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("submits the selected option", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <InteractionComposer
        request={singleChoiceRequest}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Backend first/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit choice" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        requestId: "req-regular-1",
        selectedOptionIds: ["backend"],
        customText: "",
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

    const frontend = screen.getByRole("button", { name: /Frontend first/ });
    const backend = screen.getByRole("button", { name: /Backend first/ });
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

    const frontend = screen.getByRole("button", { name: /Frontend first/ });
    const backend = screen.getByRole("button", { name: /Backend first/ });
    fireEvent.click(frontend);
    fireEvent.click(backend);

    expect(frontend).toHaveAttribute("aria-pressed", "true");
    expect(backend).toHaveAttribute("aria-pressed", "true");
  });

  it("shows an other option that submits custom text when available choices do not fit", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <InteractionComposer
        request={singleChoiceRequest}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Other/ }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "This is a stateful worker service" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit choice" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        requestId: "req-regular-1",
        selectedOptionIds: [],
        customText: "This is a stateful worker service",
      });
    });
  });

  it("does not render a custom text entry point when the request forbids it", () => {
    render(
      <InteractionComposer
        request={{ ...singleChoiceRequest, allowCustomText: false }}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /Other/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
