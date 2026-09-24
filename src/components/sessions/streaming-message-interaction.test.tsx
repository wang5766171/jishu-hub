import i18n from "@/i18n";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { streamStore } from "@/hooks/use-stream-store";
import type { StreamChunk } from "@/types";
import { StreamingMessage } from "./streaming-message";
import { FileViewerProvider } from "@/components/file-viewer";

const sessionId = "session-streaming-interaction";

function chunk(data: StreamChunk["data"]): StreamChunk {
  return {
    session_id: sessionId,
    event_type: data.kind,
    data,
  };
}

describe("StreamingMessage interaction ordering", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    streamStore.drop(sessionId);
  });

  it("renders an extension UI response between the question and the continued answer", () => {
    streamStore.start(sessionId, null);
    streamStore.push(sessionId, chunk({
      kind: "text_delta",
      delta: "What kind of workload is this?",
    }));
    streamStore.push(sessionId, chunk({
      kind: "interaction_request",
      request_id: "req-1",
      prompt: "Choose workload type",
      options: [],
      allow_multiple: false,
      allow_custom_text: true,
      required: true,
    }));
    streamStore.recordInteractionResponse(sessionId, "req-1", "Stateful worker service");
    streamStore.push(sessionId, chunk({
      kind: "tool_use_result",
      call_id: "call-1",
      output: "Stateful worker service",
      is_error: false,
    }));
    streamStore.push(sessionId, chunk({
      kind: "text_delta",
      delta: " Use a StatefulSet.",
    }));

    const { container } = render(
      <StreamingMessage sessionId={sessionId} />,
    );
    const text = container.textContent ?? "";

    // The InteractionCard is collapsed by default (defaultOpen=false),
    // showing the header "Interaction" instead of the answer text.
    // Verify the ordering: assistant text → interaction header → continued text.
    expect(text.indexOf("What kind of workload is this?")).toBeLessThan(
      text.indexOf("Ask user"),
    );
    expect(text.indexOf("Ask user")).toBeLessThan(
      text.indexOf("Use a StatefulSet."),
    );
  });

  it("renders a pending interaction request as the same collapsed card before it is answered", () => {
    streamStore.start(sessionId, null);
    streamStore.push(sessionId, chunk({
      kind: "text_delta",
      delta: "I need one choice.",
    }));
    streamStore.push(sessionId, chunk({
      kind: "interaction_request",
      request_id: "req-1",
      prompt: "Choose workload type",
      options: [],
      allow_multiple: false,
      allow_custom_text: true,
      required: true,
      origin: "acp_elicitation",
    }));

    const { container } = render(
      <StreamingMessage sessionId={sessionId} />,
    );

    expect(container.textContent ?? "").toContain("Ask user");
  });

  it("does not render a raw AskUserQuestion tool card beside the interaction card", () => {
    streamStore.start(sessionId, null);
    streamStore.push(sessionId, chunk({
      kind: "text_delta",
      delta: "Answer these:",
    }));
    streamStore.push(sessionId, chunk({
      kind: "interaction_request",
      request_id: "0_0",
      prompt: "Question 1",
      options: [],
      allow_multiple: false,
      allow_custom_text: true,
      required: true,
      origin: "acp_elicitation",
    }));
    streamStore.recordInteractionResponse(sessionId, "0_0", "A");
    streamStore.push(sessionId, chunk({
      kind: "interaction_request",
      request_id: "duplicate_0",
      prompt: "Question 1",
      options: [],
      allow_multiple: false,
      allow_custom_text: true,
      required: true,
      origin: "acp_elicitation",
    }));
    streamStore.recordInteractionResponse(sessionId, "duplicate_0", "A");
    streamStore.push(sessionId, chunk({
      kind: "message",
      content: [{
        type: "tool_use",
        id: "call-quiz",
        name: "AskUserQuestion",
        input: {
          questions: [{ question: "Question 1", options: [{ label: "A" }] }],
        },
      }],
    }));

    render(<StreamingMessage sessionId={sessionId} />);

    expect(screen.getByText("Ask user")).toBeInTheDocument();
    expect(screen.queryByText("Tool")).not.toBeInTheDocument();
  });
});

describe("v0.9.4 需求7 测试期：长时工具执行期间的卡片可见性（用户实测不可见）", () => {
  afterEach(() => {
    streamStore.drop(sessionId);
  });

  it("tool_use_start 后（执行中、无 result）即渲染工具卡（含命令）", () => {
    streamStore.start(sessionId, "帮我打包");
    streamStore.push(sessionId, chunk({ kind: "text_delta", delta: "正在执行打包" }));
    streamStore.push(sessionId, chunk({
      kind: "tool_use_start",
      call_id: "call-build-1",
      tool: "bash",
      input: { command: "npm run build" },
      view: { kind: "shell_exec" },
    }));
    render(<FileViewerProvider><StreamingMessage sessionId={sessionId} isComplete={false} /></FileViewerProvider>);
    // 命令应在执行期间即可见（工具卡展开区或 header 路径）
    expect(screen.getByText(/npm run build/)).toBeTruthy();
  });

  it("tool_use_progress 期间卡片保持且显示中间输出", () => {
    streamStore.start(sessionId, "帮我打包");
    streamStore.push(sessionId, chunk({
      kind: "tool_use_start",
      call_id: "call-build-2",
      tool: "bash",
      input: { command: "npm run build" },
      view: { kind: "shell_exec" },
    }));
    streamStore.push(sessionId, chunk({
      kind: "tool_use_progress",
      call_id: "call-build-2",
      partial_output: "vite building... 30%",
    }));
    render(<FileViewerProvider><StreamingMessage sessionId={sessionId} isComplete={false} /></FileViewerProvider>);
    expect(screen.getAllByText(/npm run build/).length).toBeGreaterThan(0);
    expect(screen.getByText(/vite building/)).toBeTruthy();
  });
});

describe("v0.9.4 需求10：会话阶段文案", () => {
  afterEach(() => {
    streamStore.drop(sessionId);
  });

  it("② 无任何内容且首事件未到 → 「正在赶来」", () => {
    streamStore.start(sessionId, "帮我做点事");
    render(<FileViewerProvider><StreamingMessage sessionId={sessionId} isComplete={false} agentDisplayName="机枢助手" /></FileViewerProvider>);
    expect(screen.getByText(/机枢助手 is on the way/)).toBeTruthy();
  });

  it("③ 首事件已到但无思考/工具/正文 → 「思考中」", () => {
    streamStore.start(sessionId, "帮我做点事");
    // 首事件：空 content 的 message（连接已建立但无可见输出）
    streamStore.push(sessionId, chunk({ kind: "message", content: [] }));
    render(<FileViewerProvider><StreamingMessage sessionId={sessionId} isComplete={false} /></FileViewerProvider>);
    expect(screen.getByText(/Thinking/)).toBeTruthy();
  });

  it("④ thinking 流入 → 「深度思考中」", () => {
    streamStore.start(sessionId, null);
    streamStore.push(sessionId, chunk({ kind: "thinking", delta: "分析问题中" }));
    render(<FileViewerProvider><StreamingMessage sessionId={sessionId} isComplete={false} /></FileViewerProvider>);
    expect(screen.getByText(/Deep thinking/)).toBeTruthy();
  });

  it("⑤ 工具运行中 → 「工具调用中」", () => {
    streamStore.start(sessionId, null);
    streamStore.push(sessionId, chunk({ kind: "text_delta", delta: "正在处理" }));
    streamStore.push(sessionId, chunk({
      kind: "tool_use_start", call_id: "c-phase-1", tool: "bash",
      input: { command: "ping -n 5 127.0.0.1" }, view: { kind: "shell_exec" },
    }));
    render(<FileViewerProvider><StreamingMessage sessionId={sessionId} isComplete={false} /></FileViewerProvider>);
    expect(screen.getByText(/Running tools/)).toBeTruthy();
  });

  it("⑥ 正文输出中（无运行中工具、无思考）→ 「处理中」", () => {
    streamStore.start(sessionId, null);
    streamStore.push(sessionId, chunk({ kind: "text_delta", delta: "回答内容" }));
    render(<FileViewerProvider><StreamingMessage sessionId={sessionId} isComplete={false} /></FileViewerProvider>);
    expect(screen.getByText(/Processing/)).toBeTruthy();
  });
});
