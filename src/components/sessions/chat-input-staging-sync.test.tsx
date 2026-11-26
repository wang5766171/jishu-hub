/**
 * v0.9.8 评审修复轮 R2（S 域）：待发送区的真源与排队的压缩条目。
 *  - S12-U1 / S12-U2：待发送区同步可读写——同一个 React 批次里先搬家再领取、
 *    先入队再领取，读到的都是最新状态（此前领取读的是渲染期镜像）；
 *  - S2-U11 / S2-U12：排队的上下文压缩与其它排队消息同样式；手动点「发送」
 *    立即执行压缩，不走引导通道。
 * 用真的 streamStore（这组用例不依赖它的替身）。
 */
import i18n from "@/i18n";
import { act, render, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import type { MutableRefObject } from "react";

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

const PENDING = "pending-1750000000000";
const REAL = "01a20867-bbbb-7000-8000-000000000001";
const SID = "staging-sync-session";
const CTX = { projectPath: "D:/p", agentId: "jishu-self" };

const entry = (id: string, content: string, extra: Partial<StagedMessage> = {}): StagedMessage => ({
  id,
  content,
  context: CTX,
  ...extra,
});

function mount(sessionId: string, extraProps: Record<string, unknown> = {}) {
  const apiRef = createRef<StagedGuideApi>() as MutableRefObject<StagedGuideApi | null>;
  const view = render(
    <ChatInput sessionId={sessionId} projectPath="D:/p" agentId="jishu-self" slashCommands={[]} stagedApiRef={apiRef} {...extraProps} />,
  );
  return { api: apiRef as MutableRefObject<StagedGuideApi>, view };
}

const contents = (items: StagedMessage[]) => items.map((item) => item.content);

describe("评审修复轮 R2：待发送区同步可读写", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
    invokeCommand.mockImplementation((cmd: string) =>
      cmd === "session_tool_list" ? Promise.resolve([]) : Promise.resolve({}));
  });

  it("S12-U1 同一批次里先搬家再领取：搬过去的两条都领得到，再领为空", () => {
    const { api } = mount(PENDING);
    act(() => {
      api.current.stage(PENDING, entry("st-1", "第一条"));
      api.current.stage(PENDING, entry("st-2", "第二条"));
    });
    let first: StagedMessage[] = [];
    let second: StagedMessage[] = [];
    act(() => {
      api.current.moveKey(PENDING, REAL);
      first = api.current.claimAll(REAL);
      second = api.current.claimAll(REAL);
    });
    expect(contents(first)).toEqual(["第一条", "第二条"]);
    expect(second).toEqual([]);
  });

  it("S12-U2 同一批次里入队后立刻领取：读得到；领取后立刻放回再领取：恰好是放回的那条", () => {
    const { api } = mount(SID);
    let first: StagedMessage[] = [];
    let again: StagedMessage[] = [];
    act(() => {
      api.current.stage(SID, entry("st-1", "第一条"));
      api.current.stage(SID, entry("st-2", "第二条"));
      first = api.current.claimAll(SID);
      api.current.restore(SID, [first[0]]);
      again = api.current.claimAll(SID);
    });
    expect(contents(first)).toEqual(["第一条", "第二条"]);
    expect(contents(again)).toEqual(["第一条"]);
  });

  it("入队后界面跟着显示；按会话分区，别的会话看不到", async () => {
    const { api, view } = mount(SID);
    act(() => {
      api.current.stage(SID, entry("st-1", "本会话的待发送消息"));
    });
    expect(screen.getByText("本会话的待发送消息")).toBeInTheDocument();

    view.rerender(
      <ChatInput sessionId="some-other-session" projectPath="D:/p" agentId="jishu-self" slashCommands={[]} stagedApiRef={api} />,
    );
    expect(screen.queryByText("本会话的待发送消息")).not.toBeInTheDocument();
  });
});

describe("评审修复轮 R2：待发送区里排队的上下文压缩", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(() => {
    invokeCommand.mockReset();
    invokeCommand.mockImplementation((cmd: string) =>
      cmd === "session_tool_list" ? Promise.resolve([]) : Promise.resolve({}));
  });

  it("S2-U11 压缩条目与其它排队消息同样式：可见，有编辑、删除与拖动手柄；没有发送 / 引导按钮", () => {
    const { api } = mount(SID);
    act(() => {
      api.current.stage(SID, entry("cp-1", "/compact 只保留接口设计", { kind: "compaction" }));
      api.current.stage(SID, entry("st-1", "压缩后再问的"));
    });
    const compaction = screen.getByText("/compact 只保留接口设计").closest(".flex.items-start") as HTMLElement;
    const plain = screen.getByText("压缩后再问的").closest(".flex.items-start") as HTMLElement;
    for (const card of [compaction, plain]) {
      expect(within(card).getByTitle("编辑")).toBeInTheDocument();
      expect(within(card).getByTitle("删除")).toBeInTheDocument();
      expect(within(card).getByTitle("拖动调整顺序")).toBeInTheDocument();
    }
    // 普通消息：编辑 / 删除 / 发送（拖动手柄不是按钮）
    expect(within(plain).getAllByRole("button")).toHaveLength(3);
    // 压缩条目：只有编辑 / 删除——它只按顺序轮到时执行（用户裁决 4「不立即执行」）。
    // 修前这个按钮写着「引导」，输出过程中点下去会中止正在跑的输出开始压缩。
    expect(within(compaction).getAllByRole("button")).toHaveLength(2);
    expect(within(compaction).queryByRole("button", { name: /引导|发送/ })).toBeNull();
  });

  it("S2-U12（二轮评审 R3 改）压缩条目被编辑成别的内容后仍然没有发送 / 引导按钮", () => {
    const { api } = mount(SID);
    act(() => {
      api.current.stage(SID, entry("cp-1", "你好", { kind: "compaction" }));
    });
    const card = screen.getByText("你好").closest(".flex.items-start") as HTMLElement;
    expect(within(card).getAllByRole("button")).toHaveLength(2);
    expect(within(card).queryByRole("button", { name: /引导|发送/ })).toBeNull();
  });
});
