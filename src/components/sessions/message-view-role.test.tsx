/**
 * MessageView 三角色渲染测试（需求五 · T6）。
 *
 * 设计依据：docs/task-exec-dev/02-总体设计.md §7.1。
 *
 * 验证三点：
 * 1. 不传 roleResolver → 行为与改动前完全一致（常规会话零影响，需求七）
 * 2. roleResolver 返回 orchestrator → 渲染「任务助手」标签
 * 3. roleResolver 返回 null → 降级为普通用户消息
 */
import i18n from "@/i18n";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Message } from "@/types";
import { MessageView, type MessageRoleView } from "./message-view";
import {
  buildDispatchFingerprints,
  makeDispatchRoleResolver,
} from "@/features/task-workspace/role/fingerprint";

const DISPATCH_TEXT = "Task Orchestrator: 请实现登录接口";

const messages: Message[] = [
  { role: "user", timestamp: null, content: [{ type: "text", text: DISPATCH_TEXT }] },
  { role: "assistant", timestamp: null, content: [{ type: "text", text: "好的" }] },
  { role: "user", timestamp: null, content: [{ type: "text", text: "顺手加个单测" }] },
];

describe("MessageView roleResolver（三角色）", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  it("不传 roleResolver 时不渲染任务助手标签（常规会话零影响）", () => {
    render(<MessageView messages={messages} flat />);
    expect(screen.queryByText("任务助手")).toBeNull();
  });

  it("roleResolver 返回 orchestrator 时渲染任务助手标签", () => {
    const resolver = (msg: Message): MessageRoleView | null =>
      msg.role === "user" && msg.content.some((b) => b.type === "text" && b.text === DISPATCH_TEXT)
        ? { role: "orchestrator", label: "任务助手", align: "right", tone: "primary" }
        : null;

    render(<MessageView messages={messages} flat roleResolver={resolver} />);
    // 只有第一条派发消息带标签，第二条真人消息不带
    expect(screen.getAllByText("任务助手")).toHaveLength(1);
  });

  it("roleResolver 恒返回 null 时降级为普通用户消息", () => {
    const resolver = vi.fn(() => null);
    render(<MessageView messages={messages} flat roleResolver={resolver} />);
    expect(screen.queryByText("任务助手")).toBeNull();
    // 两条 user 消息都被解析器过了一遍
    expect(resolver).toHaveBeenCalled();
  });

  it("与派发指纹工具联调：仅命中派发 prompt 的消息标记为任务助手", () => {
    // 后端派发 prompt 与会话内文本存在空白差异，归一化后仍应命中
    const fingerprints = buildDispatchFingerprints([`  Task Orchestrator:   请实现登录接口  `]);
    const resolver = makeDispatchRoleResolver(fingerprints, "任务助手");

    render(<MessageView messages={messages} flat roleResolver={resolver} />);
    expect(screen.getAllByText("任务助手")).toHaveLength(1);
  });
});
