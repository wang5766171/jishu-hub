/**
 * v0.9.6 需求1 完善修复②回放端到端：真实后端回放数据（01a1b1a6 会话尾部，
 * 含 2 条 compaction divider）喂 MessageView，断言分隔线渲染——
 * 闭环「重启后回放 divider 可见」的前端最后一环（后端返回已实测含 divider）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { MessageView } from "@/components/sessions/message-view";

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "__fixtures__/replay-01a1b1a6-tail.json"), "utf-8"),
) as {
  role: string;
  content: { type: string; phase?: string; title?: string }[];
}[];

describe("v0.9.6 需求1 完善②：回放端到端（真实数据渲染 divider）", () => {
  beforeEach(() => cleanup());

  it("真实回放尾部（含 compaction divider）经 MessageView 渲染出「上下文已压缩」分隔线", () => {
    expect(fixture.some(m => m.content.some(c => c.type === "phase_divider" && c.phase === "compaction"))).toBe(true);
    render(
      <MessageView
        messages={fixture as never}
        sessionId="s1"
        flat
      />,
    );
    // PhaseDivider 渲染 title 文本
    expect(screen.getAllByText("上下文已压缩").length).toBeGreaterThanOrEqual(1);
  });
});
