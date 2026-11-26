/**
 * v0.9.6 需求1 完善修复②回放端到端：会话尾部的回放样本（120 条消息，末尾含
 * 1 条 compaction divider）喂 MessageView，断言分隔线渲染——
 * 闭环「重启后回放 divider 可见」的前端最后一环（后端返回已实测含 divider）。
 *
 * 样本是合成数据（`__fixtures__/replay-compaction-tail.json`）：按真实会话尾部的
 * 结构生成——角色序列、每条消息的块类型序列、工具调用与结果的配对、分隔线所在
 * 位置都与真实回放一致，文本内容全部是虚构的示例项目（按标签筛选笔记）。
 * 真实会话抓取不入库。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { MessageView } from "@/components/sessions/message-view";

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "__fixtures__/replay-compaction-tail.json"), "utf-8"),
) as {
  role: string;
  content: { type: string; phase?: string; title?: string }[];
}[];

describe("v0.9.6 需求1 完善②：回放端到端（会话尾部样本渲染 divider）", () => {
  beforeEach(() => cleanup());

  it("回放尾部样本（120 条消息，含 compaction divider）经 MessageView 渲染出「上下文已压缩」分隔线", () => {
    expect(fixture).toHaveLength(120);
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
