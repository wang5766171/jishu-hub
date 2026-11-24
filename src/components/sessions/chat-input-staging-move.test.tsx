// v0.9.8 需求21：会话 id 解析完成前暂存的消息——随 id 解析搬到真实键，不丢。
// 修前：暂存记在临时键（pending-…）下，id 解析后界面改读真实键下的空列表，
// 卡片消失且回合结束的自动投递也领不到（消息无声丢失）。
import i18n from "@/i18n";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";

import { streamStore } from "@/hooks/use-stream-store";
import { ChatInput, type StagedGuideApi } from "./chat-input";
import type { StagedMessage } from "./message-staging";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

beforeEach(() => {
  invokeCommand.mockReset();
  invokeCommand.mockImplementation((cmd: string) => {
    if (cmd === "session_tool_list") return Promise.resolve([]);
    if (cmd === "equip_config_get")
      return Promise.resolve({ enabled: true, session_card: true, session_limit: 1, input_bar: true, market_zone: true, third_party: true });
    if (cmd === "equipment_tags_list") return Promise.resolve([]);
    if (cmd === "task_profile_latest") return Promise.resolve(null);
    if (cmd === "plugin_list") return Promise.resolve({ plugins: [] });
    if (cmd === "skillhub_installed") return Promise.resolve({});
    if (cmd === "pi_package_installed_sources") return Promise.resolve([]);
    if (cmd === "get_scene_suggest_dismissed") return Promise.resolve(false);
    if (cmd === "workspace_scene") return Promise.resolve(null);
    return Promise.resolve({});
  });
});

const PENDING = "pending-1750000000000";
const REAL = "01a20867-aaaa-7000-8000-000000000001";

/** 回合进行中（首条已发、会话头还是临时键）连发两条 → 都进暂存。 */
async function stageTwoWhileStreaming(rerender: (ui: React.ReactNode) => void) {
  streamStore.start(PENDING, "首条：数到 600");
  const textarea = await waitFor(() => {
    const el = document.querySelector("textarea") as HTMLTextAreaElement | null;
    if (!el) throw new Error("textarea not rendered");
    return el;
  });
  for (const text of ["第一条暂存", "第二条暂存"]) {
    fireEvent.change(textarea, { target: { value: text } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter", charCode: 13 });
    });
  }
  await waitFor(() => {
    expect(document.body.textContent).toContain("第一条暂存");
    expect(document.body.textContent).toContain("第二条暂存");
  });
  // 回合结束（流移除）——此后切到真实键时不会被当成另一个流式会话。
  streamStore.drop(PENDING);
  void rerender;
}

describe("需求21：待发送区随会话 id 解析搬家", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh");
    streamStore.drop(PENDING);
    streamStore.drop(REAL);
  });

  it("U3-1 临时键下的暂存在 id 解析后跟到真实键（保序）", async () => {
    const apiRef = createRef<StagedGuideApi>() as React.MutableRefObject<StagedGuideApi | null>;
    const ui = (sessionId: string) => (
      <ChatInput sessionId={sessionId} projectPath="D:\\p" agentId="jishu-self" slashCommands={[]} stagedApiRef={apiRef} />
    );
    const view = render(ui(PENDING));
    await stageTwoWhileStreaming(view.rerender);

    // 会话 id 解析事件：与引导队列同点搬暂存区，随后界面切到真实 id。
    act(() => {
      apiRef.current!.moveKey(PENDING, REAL);
    });
    view.rerender(ui(REAL));
    const text = document.body.textContent ?? "";
    expect(text).toContain("第一条暂存");
    expect(text).toContain("第二条暂存");
    expect(text.indexOf("第一条暂存")).toBeLessThan(text.indexOf("第二条暂存"));

    // 回合结束的自动投递按真实键能领到这两条（修前领到空）。
    let claimed: Array<{ content: string }> = [];
    act(() => {
      claimed = apiRef.current!.claimAll(REAL) as Array<{ content: string }>;
    });
    expect(claimed.map((m) => m.content)).toEqual(["第一条暂存", "第二条暂存"]);
  });

  it("U3-2 「已领取」标记随条目搬家——换键后同一条不会被再领一次", async () => {
    const apiRef = createRef<StagedGuideApi>() as React.MutableRefObject<StagedGuideApi | null>;
    const view = render(
      <ChatInput sessionId={PENDING} projectPath="D:\\p" agentId="jishu-self" slashCommands={[]} stagedApiRef={apiRef} />,
    );
    await stageTwoWhileStreaming(view.rerender);

    // 自动投递领走两条（= 都已标记领取），其中一条投递失败被放回。
    let first: StagedMessage[] = [];
    act(() => {
      first = apiRef.current!.claimAll(PENDING);
    });
    expect(first).toHaveLength(2);
    act(() => {
      apiRef.current!.restore(PENDING, [first[0]]);
    });
    act(() => {
      apiRef.current!.moveKey(PENDING, REAL);
    });

    // 真实键下再领：只有被放回的那一条；另一条的「已领取」没有被换键冲掉。
    let again: Array<{ content: string }> = [];
    act(() => {
      again = apiRef.current!.claimAll(REAL) as Array<{ content: string }>;
    });
    expect(again.map((m) => m.content)).toEqual(["第一条暂存"]);
  });

  it("U3-3 切到别的会话不搬：暂存留在原会话键下", async () => {
    const apiRef = createRef<StagedGuideApi>() as React.MutableRefObject<StagedGuideApi | null>;
    const ui = (sessionId: string) => (
      <ChatInput sessionId={sessionId} projectPath="D:\\p" agentId="jishu-self" slashCommands={[]} stagedApiRef={apiRef} />
    );
    const view = render(ui(PENDING));
    await stageTwoWhileStreaming(view.rerender);

    view.rerender(ui("some-other-session"));
    expect(document.body.textContent).not.toContain("第一条暂存");

    view.rerender(ui(PENDING));
    expect(document.body.textContent).toContain("第一条暂存");
    expect(document.body.textContent).toContain("第二条暂存");
  });
});
