/**
 * v0.9.8 评审修复轮 R2（裁决 4 / C3）：压缩请求的去向——回合进行中进待发送区，
 * 引擎空闲立即执行，压缩进行中提示。对应 tests/S-用例清单 S2-U1～S2-U5。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";

import { streamStore } from "@/hooks/use-stream-store";
import type { StagedGuideApi } from "@/components/sessions/chat-input";
import { useCompactionRequest } from "./use-compaction-request";

const SID = "compact-request-session";
const CTX = { projectPath: "D:/p", agentId: "jishu-self" };

function setup(selected: string | null = SID, compactionRunning = false) {
  const runCompact = vi.fn(async (): Promise<"done" | "skipped"> => "done");
  const isCompacting = vi.fn((sessionId: string) => compactionRunning && sessionId === SID);
  const stagedApi: StagedGuideApi = {
    claimAll: vi.fn(() => []),
    restore: vi.fn(),
    moveKey: vi.fn(),
    stage: vi.fn(),
  };
  const alertDialog = vi.fn();
  const refs = {
    projectPathRef: { current: "D:/p" } as MutableRefObject<string | null>,
    selectedSessionRef: { current: selected } as MutableRefObject<string | null>,
    stagedApiRef: { current: stagedApi } as MutableRefObject<StagedGuideApi | null>,
  };
  const { result } = renderHook(() =>
    useCompactionRequest({
      runCompact,
      isCompacting,
      activeId: "jishu-self",
      ...refs,
      alertDialog,
      t: ((k: string) => k) as never,
    }),
  );
  return { request: result.current, runCompact, stagedApi, alertDialog, ...refs };
}

describe("评审修复轮 R2：压缩请求的去向（压缩与普通消息等价处理）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamStore.drop(SID);
  });

  it("S2-U1 回合进行中请求压缩 → 进待发送区，不立即执行", async () => {
    streamStore.start(SID, "正在回答的问题");
    const env = setup();
    await act(async () => {
      await env.request(null);
    });
    expect(env.stagedApi.stage).toHaveBeenCalledTimes(1);
    const [key, entry] = (env.stagedApi.stage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(key).toBe(SID);
    expect(entry).toMatchObject({ content: "/compact", kind: "compaction", context: CTX });
    expect(env.runCompact).not.toHaveBeenCalled();
    streamStore.drop(SID);
  });

  it("S2-U2 引擎空闲请求压缩 → 立即执行，不进待发送区", async () => {
    const env = setup();
    await act(async () => {
      await env.request(null);
    });
    expect(env.runCompact).toHaveBeenCalledTimes(1);
    expect(env.runCompact).toHaveBeenCalledWith(SID, null, { agentId: "jishu-self", projectPath: "D:/p" });
    expect(env.stagedApi.stage).not.toHaveBeenCalled();
    expect(env.alertDialog).not.toHaveBeenCalled();
  });

  it("S2-U3 压缩进行中再次请求（同一会话）→ 提示，不排队不执行", async () => {
    const env = setup(SID, true);
    await act(async () => {
      await env.request(null);
    });
    expect(env.alertDialog).toHaveBeenCalledWith({
      title: "sessions.compactRunning",
      description: "sessions.compactAlreadyRunning",
    });
    expect(env.runCompact).not.toHaveBeenCalled();
    expect(env.stagedApi.stage).not.toHaveBeenCalled();
  });

  it("S2-U4 带补充要求：排队条目的内容就是命令原文", async () => {
    streamStore.start(SID, "正在回答的问题");
    const env = setup();
    await act(async () => {
      await env.request("只保留接口设计");
    });
    expect(env.stagedApi.stage).toHaveBeenCalledWith(SID, expect.objectContaining({ content: "/compact 只保留接口设计" }));
    streamStore.drop(SID);
  });

  it("S2-U5 没有选中会话：什么都不做", async () => {
    const env = setup("new");
    await act(async () => {
      await env.request(null);
    });
    expect(env.runCompact).not.toHaveBeenCalled();
    expect(env.stagedApi.stage).not.toHaveBeenCalled();
    expect(env.alertDialog).not.toHaveBeenCalled();
  });
});
