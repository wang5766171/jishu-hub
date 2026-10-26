import { describe, expect, it } from "vitest";
import type { ContentBlock, Message } from "@/types";
import {
  buildSessionRows,
  buildTurnSummaries,
} from "./build-session-rows";

function textMsg(role: "user" | "assistant", text: string): Message {
  return {
    role,
    timestamp: null,
    content: [{ type: "text", text }],
  };
}

function toolResultUserMsg(): Message {
  return {
    role: "user",
    timestamp: null,
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "ok" } as ContentBlock,
    ],
  };
}

function toolUseAssistantMsg(): Message {
  return {
    role: "assistant",
    timestamp: null,
    content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
  };
}

describe("buildSessionRows（v0.9.2 需求1 P1 统一行语义）", () => {
  it("连续 assistant 归并为一组，user 各占一行并获递增轮次序号", () => {
    const rows = buildSessionRows([
      textMsg("user", "问1"),
      textMsg("assistant", "答1a"),
      textMsg("assistant", "答1b"),
      textMsg("user", "问2"),
      textMsg("assistant", "答2"),
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ kind: "user", messageIndex: 0, turnIndex: 0 });
    expect(rows[1]).toMatchObject({ kind: "assistant", startIndex: 1, endIndex: 2, messageIndices: [1, 2] });
    expect(rows[2]).toMatchObject({ kind: "user", messageIndex: 3, turnIndex: 1 });
    expect(rows[3]).toMatchObject({ kind: "assistant", startIndex: 4, endIndex: 4 });
  });

  it("纯 tool_result 的 user 消息被吞并进前导 assistant 组（不占行不占轮次）", () => {
    const rows = buildSessionRows([
      textMsg("user", "问"),
      toolUseAssistantMsg(),
      toolResultUserMsg(),
      textMsg("assistant", "结论"),
      textMsg("user", "问2"),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[1].kind).toBe("assistant");
    expect(rows[1].messageIndices).toEqual([1, 2, 3]);
    expect(rows[2]).toMatchObject({ kind: "user", turnIndex: 1 });
  });

  it("会话开头无 user 的 assistant 组不计轮次；行内轮次序号与轮次摘要一一对应", () => {
    const messages = [
      textMsg("assistant", "开场白"),
      textMsg("user", "问1"),
      textMsg("assistant", "答1"),
      textMsg("user", "问2"),
    ];
    const rows = buildSessionRows(messages);
    const userTurnIndexes = rows
      .filter((row) => row.kind === "user")
      .map((row) => row.turnIndex);
    expect(userTurnIndexes).toEqual([0, 1]);
    const summaries = buildTurnSummaries(messages, rows);
    expect(summaries).toHaveLength(2);
    // 第 N 条轮次摘要 ↔ 第 N 个 turnIndex 的 user 行（横杠↔DOM 严格对应）
    expect(summaries[0]).toEqual({ question: "问1", answer: "答1" });
    expect(summaries[1]).toEqual({ question: "问2", answer: "" });
  });

  it("answer 取轮后 assistant 组首个非空 text（多消息组跨 tool 消息取结论）", () => {
    const summaries = buildTurnSummaries([
      textMsg("user", "问"),
      toolUseAssistantMsg(),
      textMsg("assistant", "最终结论"),
    ]);
    expect(summaries[0].answer).toBe("最终结论");
  });
});
