import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { streamStore, type StreamChunk } from "@/hooks/use-stream-store";
import type { StreamState } from "@/hooks/use-stream-store";

/** 需求4 测试期（用户实测 08:39：打包工具卡丢失）：复现那轮真实事件序列。 */
function chunk(data: Record<string, unknown>): StreamChunk {
  return { agent_id: "jishu-self", session: "01a0d868", data } as StreamChunk;
}

describe("复现：长空窗后到达的工具卡是否保留", () => {
  afterEach(() => {
    streamStore.drop("01a0d868");
  });

  it("tool_use_start 在长延迟后到达（紧接 result）——state.content 与 tools 均应含该工具", () => {
    const sid = "01a0d868";
    streamStore.start(sid, "工具卡片如图所示，不显示完整的命令了");
    // 前序：thinking + text + 工具1（58s）完成
    streamStore.push(sid, chunk({ kind: "thinking", delta: "分析" }));
    streamStore.push(sid, chunk({ kind: "text_delta", delta: "先识图" }));
    streamStore.push(sid, chunk({
      kind: "tool_use_start", call_id: "call_fdc", tool: "bash",
      input: { command: "git commit" }, view: { kind: "shell_exec" },
    }));
    streamStore.push(sid, chunk({ kind: "tool_use_result", call_id: "call_fdc", output: "ok", is_error: false }));
    // 15 分钟空窗后：b77（打包）start + progress + result 几乎同时到达
    streamStore.push(sid, chunk({
      kind: "tool_use_start", call_id: "call_b77", tool: "bash",
      input: { command: "npm run build" }, view: { kind: "shell_exec" },
    }));
    streamStore.push(sid, chunk({ kind: "tool_use_progress", call_id: "call_b77", partial_output: "building..." }));
    streamStore.push(sid, chunk({ kind: "tool_use_result", call_id: "call_b77", output: "built 57MB", is_error: false }));
    streamStore.push(sid, chunk({ kind: "text_delta", delta: "安装包已出" }));

    const state = streamStore.getState(sid) as StreamState | undefined;
    expect(state).toBeTruthy();
    const b77 = state!.tools.find((t) => t.id === "call_b77");
    expect(b77, "tools 数组应含 b77").toBeTruthy();
    expect(b77!.output).toBe("built 57MB");
    const contentToolUse = state!.content.find(
      (b) => b.type === "tool_use" && (b as { id?: string }).id === "call_b77",
    );
    expect(contentToolUse, "content 应含 b77 的 tool_use 块（提交数据源）").toBeTruthy();
    const contentToolResult = state!.content.find(
      (b) => b.type === "tool_result" && (b as { tool_use_id?: string }).tool_use_id === "call_b77",
    );
    expect(contentToolResult, "content 应含 b77 的 tool_result 块").toBeTruthy();
  });

  it("message 事件兜底补块路径：message_end 块序列含两个 tool_use 均应入 content", () => {
    const sid = "01a0d868";
    streamStore.start(sid, "test");
    streamStore.push(sid, chunk({
      kind: "message",
      content: [
        { type: "text", text: "前言" },
        { type: "tool_use", id: "call_x1", name: "bash", input: { command: "a" } },
        { type: "tool_use", id: "call_x2", name: "bash", input: { command: "npm run build" } },
      ],
    }));
    const state = streamStore.getState(sid) as StreamState | undefined;
    const ids = state!.tools.map((t) => t.id);
    expect(ids).toContain("call_x1");
    expect(ids).toContain("call_x2");
  });
});
