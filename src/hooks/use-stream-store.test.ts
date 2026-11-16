import { describe, expect, it } from "vitest";

import { streamStore } from "./use-stream-store";
import type { StreamChunk } from "@/types";

function chunk(data: StreamChunk["data"]): StreamChunk {
  return {
    session_id: "session-interaction",
    event_type: data.kind,
    data,
  };
}

describe("streamStore interaction requests", () => {
  it("records extension UI interaction responses at the request position", () => {
    streamStore.drop("session-interaction");
    streamStore.start("session-interaction", "plan a deployment");

    streamStore.push(
      "session-interaction",
      chunk({
      kind: "text_delta",
      delta: "What kind of workload is this?",
      }),
    );
    streamStore.push(
      "session-interaction",
      chunk({
      kind: "interaction_request",
      request_id: "req-1",
      prompt: "Choose workload type",
      options: [],
      allow_multiple: false,
      allow_custom_text: true,
      required: true,
      }),
    );

    expect(
      streamStore.recordInteractionResponse(
      "session-interaction",
      "req-1",
      "Stateful worker service",
      ),
    ).toBe(true);

    streamStore.push(
      "session-interaction",
      chunk({
      kind: "tool_use_result",
      call_id: "call-1",
      output: "Stateful worker service",
      is_error: false,
      }),
    );
    streamStore.push(
      "session-interaction",
      chunk({
      kind: "text_delta",
      delta: " Use a StatefulSet.",
      }),
    );

    expect(
      streamStore.getState("session-interaction")?.interactionSplits,
    ).toEqual([
      {
        requestId: "req-1",
        index: 1,
        text: "Stateful worker service",
        prompt: "Choose workload type",
        options: [],
        origin: undefined,
        selectedOptions: [],
      },
    ]);

    streamStore.drop("session-interaction");
  });

  it("starts continuations for phase dividers and interactions only", () => {
    const sessionId = "session-continuation";
    streamStore.drop(sessionId);

    const divider = {
      ...chunk({ kind: "phase_divider", phase: "plan", title: "流程规划" }),
      session_id: sessionId,
    } satisfies StreamChunk;
    expect(streamStore.pushTracked(sessionId, divider)).toBe(true);
    expect(streamStore.getState(sessionId)?.content).toEqual([
      { type: "phase_divider", phase: "plan", title: "流程规划" },
    ]);

    expect(streamStore.pushTracked(sessionId, divider)).toBe(true);
    expect(streamStore.getState(sessionId)?.content).toHaveLength(1);
    streamStore.drop(sessionId);

    const completionData = {
      kind: "turn_complete",
      reason: "Complete",
      usage: null,
    } satisfies StreamChunk["data"];
    const completion = {
      ...chunk(completionData),
      session_id: sessionId,
    } satisfies StreamChunk;
    expect(streamStore.pushTracked(sessionId, completion)).toBe(false);
    expect(streamStore.getState(sessionId)).toBeNull();

    const interaction = {
      ...chunk({
        kind: "interaction_request",
        request_id: "gate-1",
        prompt: "是否进入规划？",
        options: [],
        allow_multiple: false,
        allow_custom_text: true,
        required: true,
      }),
      session_id: sessionId,
    } satisfies StreamChunk;
    expect(streamStore.pushTracked(sessionId, interaction)).toBe(true);
    expect(
      streamStore.getState(sessionId)?.interactionSplits[0]?.requestId,
    ).toBe("gate-1");
    streamStore.drop(sessionId);
  });

  it("rolls back an optimistic interaction response", () => {
    const sessionId = "session-rollback";
    streamStore.drop(sessionId);
    streamStore.start(sessionId, null);
    streamStore.push(sessionId, {
      ...chunk({
        kind: "interaction_request",
        request_id: "req-rollback",
        prompt: "继续吗？",
        options: [],
        allow_multiple: false,
        allow_custom_text: true,
        required: true,
      }),
      session_id: sessionId,
    });

    const checkpoint = streamStore.recordInteractionResponseWithCheckpoint(
      sessionId,
      "req-rollback",
      "继续",
    );
    expect(streamStore.getState(sessionId)?.interactionSplits[0]?.text).toBe(
      "继续",
    );
    expect(streamStore.rollbackInteractionResponse(checkpoint)).toBe(true);
    expect(
      streamStore.getState(sessionId)?.interactionSplits[0]?.text,
    ).toBeNull();
    streamStore.drop(sessionId);
  });
});

describe("getStreamingIds（v0.9.3 测试期修复：别名展开）", () => {
  it("流式状态的键与其别名（真实 session id）都在集合中——列表行整轮可匹配", () => {
    const pendingId = "pending-abc";
    const realId = "pi-real-session-id-1234";
    streamStore.start(pendingId, "hi");
    // session_resolved 路径：resolvedId 记录 + aliases 登记真实 id → 键。
    streamStore.push(pendingId, {
      agent_id: "jishu-self",
      session_id: pendingId,
      data: { kind: "session_resolved", session_id: realId },
    } as never);
    const ids = streamStore.getStreamingIds();
    expect(ids).toContain(pendingId);
    expect(ids).toContain(realId);
    // 结束后两者都不在。
    streamStore.end(pendingId);
    const after = streamStore.getStreamingIds();
    expect(after).not.toContain(pendingId);
    expect(after).not.toContain(realId);
    streamStore.drop(pendingId);
  });
});

describe("v0.9.5 需求2 测试期：复用连接回合的阶段升级（resolvedOnce 跨回合记忆）", () => {
  it("曾 session_resolved 的会话：后续回合 markPromptAccepted 直入③（思考中），不再永显②「正在赶来」", () => {
    const pendingId = "pending-reuse-001";
    const realId = "pi-reuse-real-session-id-01";
    // 第一回合：spawn → session_resolved（真实 id 经 push 登记别名与 resolvedOnce）→ 结束 drop。
    streamStore.start(pendingId, "第一条");
    streamStore.push(pendingId, {
      agent_id: "jishu-self",
      session_id: pendingId,
      data: { kind: "session_resolved", session_id: realId },
    } as never);
    expect(streamStore.getState(pendingId)?.sessionResolved).toBe(true);
    streamStore.drop(pendingId);

    // 第二回合（复用进程：连接只解析一次，不会再发 session_resolved）——
    // 模型流挂死/首响应慢时，受理确认即应升级③，而非停在②。
    streamStore.start(realId, "继续");
    expect(streamStore.getState(realId)?.sessionResolved).toBe(false); // start 重置
    streamStore.markPromptAccepted(realId);
    const state = streamStore.getState(realId);
    expect(state?.promptAccepted).toBe(true);
    expect(state?.sessionResolved).toBe(true);
    expect(state?.hasReceivedEvent).toBe(true);
    streamStore.drop(realId);
  });

  it("全新会话（从未解析过）：markPromptAccepted 保持②——spawn 期间 IPC 早返回，等权威 session_resolved", () => {
    const pendingId = "pending-fresh-never-resolved";
    streamStore.start(pendingId, "首条");
    streamStore.markPromptAccepted(pendingId);
    const state = streamStore.getState(pendingId);
    expect(state?.promptAccepted).toBe(true);
    expect(state?.sessionResolved).toBe(false);
    expect(state?.hasReceivedEvent).toBe(false);
    streamStore.drop(pendingId);
  });
});

// v0.9.5 需求2 测试期修复（会话 01a0ed19 实证）：回合令牌（turnToken）——
// 停止幂等的判别依据。同回合（同 start）令牌稳定（push 透传不换），新回合
//（新 start）必换新令牌；替代旧 10s 墙钟时间窗（窗口过期后同一滞留流再次
// 本地提交 = spawn 期停止后用户消息重复渲染的根因）。
describe("streamStore turnToken（停止幂等的回合令牌）", () => {
  it("同回合：push 逐字段重建不换令牌；新回合（重新 start）必换新令牌", () => {
    const sid = "session-turn-token";
    streamStore.drop(sid);
    streamStore.start(sid, "首条");
    const token1 = streamStore.getState(sid)!.turnToken;

    streamStore.push(sid, chunk({
      kind: "text_delta",
      delta: "部分回复",
    }));
    expect(streamStore.getState(sid)!.turnToken).toBe(token1);

    streamStore.push(sid, chunk({
      kind: "tool_use_start",
      call_id: "call-1",
      tool: "read",
      input: {},
    }));
    expect(streamStore.getState(sid)!.turnToken).toBe(token1);

    // 停止后重发（新回合）：新令牌 → 幂等标记（旧令牌）自动失配放行。
    streamStore.start(sid, "第二条");
    const token2 = streamStore.getState(sid)!.turnToken;
    expect(token2).not.toBe(token1);
    streamStore.drop(sid);
  });

  it("别名解析后（pending → 真实 id）令牌同源：两键读到同一令牌", () => {
    const pendingId = "pending-turn-token";
    const realId = "real-turn-token";
    streamStore.drop(pendingId);
    streamStore.start(pendingId, "首条");
    streamStore.push(pendingId, {
      session_id: pendingId,
      event_type: "session_resolved",
      data: { kind: "session_resolved", session_id: realId },
    } as never);
    const viaPending = streamStore.getState(pendingId)!.turnToken;
    const viaReal = streamStore.getState(realId)!.turnToken;
    expect(viaPending).toBe(viaReal);
    streamStore.drop(pendingId);
  });
});
