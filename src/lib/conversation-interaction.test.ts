import { describe, expect, it } from "vitest";

import {
  decorateInteractionOptions,
  formatInteractionResponseValue,
  formatInteractionReply,
  interactionRequestFromEvent,
  validateInteractionSubmission,
} from "./conversation-interaction";
import type {
  ConversationInteractionRequest,
  ConversationInteractionSubmission,
  NormalizedEvent,
} from "@/types";

const request: ConversationInteractionRequest = {
  requestId: "req-1",
  prompt: "请选择优先实施方向",
  options: [
    { optionId: "frontend", label: "前端优先" },
    { optionId: "backend", label: "后端优先", description: "先完成接口和权限模型" },
    { optionId: "parallel", label: "前后端并行" },
  ],
  allowMultiple: false,
  allowCustomText: true,
  required: true,
};

describe("conversation interaction", () => {
  it("validates a selected option with custom text", () => {
    const submission = validateInteractionSubmission(request, {
      selectedOptionIds: ["backend"],
      customText: "优先完成组织数据权限",
    });

    expect(submission).toEqual({
      requestId: "req-1",
      selectedOptionIds: ["backend"],
      customText: "优先完成组织数据权限",
    });
  });

  it("formats a readable reply without exposing transport metadata", () => {
    const submission: ConversationInteractionSubmission = {
      requestId: "req-1",
      selectedOptionIds: ["backend"],
      customText: "先做接口",
    };

    const reply = formatInteractionReply(request, submission);

    expect(reply).toContain("后端优先");
    expect(reply).toContain("先做接口");
    expect(reply).not.toContain("req-1");
    expect(reply).not.toContain("optionId");
  });

  it("formats the transport response value expected by extension UI", () => {
    expect(
      formatInteractionResponseValue(request, {
        requestId: "req-1",
        selectedOptionIds: ["backend"],
        customText: "",
      }),
    ).toBe("后端优先");

    expect(
      formatInteractionResponseValue(
        { ...request, options: [] },
        {
          requestId: "req-1",
          selectedOptionIds: [],
          customText: "Use the existing cluster",
        },
      ),
    ).toBe("Use the existing cluster");
  });

  it("rejects an option that does not belong to the request", () => {
    expect(() =>
      validateInteractionSubmission(request, {
        selectedOptionIds: ["unknown"],
        customText: "",
      }),
    ).toThrow("interaction option is invalid");
  });

  it("requires a selection or custom text for required interactions", () => {
    expect(() =>
      validateInteractionSubmission(request, {
        selectedOptionIds: [],
        customText: "   ",
      }),
    ).toThrow("interaction response is required");
  });

  it("rejects multiple selections for a single-choice request", () => {
    expect(() =>
      validateInteractionSubmission(request, {
        selectedOptionIds: ["frontend", "backend"],
        customText: "",
      }),
    ).toThrow("interaction only allows one option");
  });

  it("maps a normalized agent event into the shared request model", () => {
    const event: NormalizedEvent = {
      kind: "interaction_request",
      request_id: "req-event-1",
      prompt: "Choose one",
      options: [
        {
          option_id: "a",
          label: "Option A",
          description: "First option",
        },
      ],
      allow_multiple: false,
      allow_custom_text: true,
      required: true,
      transport: "pi_rpc",
      origin: "extension_ui",
      delivery_hint: "mid_turn",
      correlation: { request_kind: "extension_ui", jsonrpc_id: 42 },
    };

    expect(interactionRequestFromEvent(event)).toEqual({
      requestId: "req-event-1",
      prompt: "Choose one",
      options: [
        {
          optionId: "a",
          label: "Option A",
          description: "First option",
        },
      ],
      allowMultiple: false,
      allowCustomText: true,
      required: true,
      transport: "pi_rpc",
      origin: "extension_ui",
      deliveryHint: "mid_turn",
      correlation: { request_kind: "extension_ui", jsonrpc_id: 42 },
    });
  });

  it("defaults legacy interaction events (without v0.6.0 fields) to a null correlation", () => {
    const event: NormalizedEvent = {
      kind: "interaction_request",
      request_id: "legacy-1",
      prompt: "Legacy question",
      options: [],
      allow_multiple: false,
      allow_custom_text: false,
      required: true,
    };

    const mapped = interactionRequestFromEvent(event);
    expect(mapped.transport).toBeUndefined();
    expect(mapped.origin).toBeUndefined();
    expect(mapped.deliveryHint).toBeUndefined();
    expect(mapped.correlation).toBeNull();
  });
});

// v0.9.5 需求5 测试期：rpiv-ask 选项串展示净化。
describe("decorateInteractionOptions（rpiv-ask 选项串净化）", () => {
  it("剥序号前缀；各不相同的 description 转为次行", () => {
    const out = decorateInteractionOptions([
      { optionId: "1. 红 — 红色选项", label: "1. 红 — 红色选项", description: null },
      { optionId: "2. 绿 — 绿色选项", label: "2. 绿 — 绿色选项", description: null },
    ]);
    expect(out[0]).toMatchObject({ label: "红", description: "红色选项" });
    expect(out[1]).toMatchObject({ label: "绿", description: "绿色选项" });
    // optionId 原样保留（提交协议不变）
    expect(out[0].optionId).toBe("1. 红 — 红色选项");
  });

  it("统一占位 description（如「就选这个？」）不展示", () => {
    const out = decorateInteractionOptions([
      { optionId: "a", label: "1. 花瓶 — 就选这个？", description: null },
      { optionId: "b", label: "2. 鸡蛋 — 就选这个？", description: null },
      { optionId: "c", label: "3. 窗户 — 就选这个？", description: null },
    ]);
    expect(out.map((o) => o.label)).toEqual(["花瓶", "鸡蛋", "窗户"]);
    expect(out.every((o) => o.description === null)).toBe(true);
  });

  it("无 description 后缀（剥哨兵后的纯标签）只剥序号", () => {
    const out = decorateInteractionOptions([
      { optionId: "a", label: "1. 红", description: null },
      { optionId: "b", label: "2. 绿", description: null },
    ]);
    expect(out.map((o) => o.label)).toEqual(["红", "绿"]);
    expect(out.every((o) => o.description === null)).toBe(true);
  });

  it("非 rpiv 形态（无序号前缀）原样返回", () => {
    const out = decorateInteractionOptions([
      { optionId: "a", label: "继续", description: null },
      { optionId: "b", label: "停止", description: "放弃当前任务", },
    ]);
    expect(out[0]).toMatchObject({ label: "继续" });
    expect(out[1]).toMatchObject({ label: "停止", description: "放弃当前任务" });
  });

  it("混排（部分有序号）不处理，避免误剥", () => {
    const out = decorateInteractionOptions([
      { optionId: "a", label: "1. 红", description: null },
      { optionId: "b", label: "继续", description: null },
    ]);
    expect(out[0].label).toBe("1. 红");
  });
});
