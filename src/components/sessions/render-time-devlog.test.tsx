/**
 * 渲染期间不写开发日志——v0.9.8 需求23 回归守卫（tests/06-测试清单 S23-U22）。
 *
 * 日志面板用 useSyncExternalStore 订阅日志：渲染函数执行期间写一条日志，面板会
 * 被同步刷新，把正在进行的低优先级渲染（如搜索词延迟生效那条）打断重来。
 * 实测（开发实例）：输入搜索词后页面每 8 毫秒空转一轮，搜索永远不生效。
 *
 * 做法：先挂一个同样订阅日志的空组件，再渲染消息视图树的各条路径。只要有人在
 * 渲染期间写日志，React 就会报「渲染一个组件时更新另一个组件」——断言没有这条
 * 报错；同时断言这些日志在提交之后确实写进去了（诊断信息没有丢）。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { devLogVersion, getDevLogs, subscribeDevLogs } from "@/lib/dev-log";
import { streamStore } from "@/hooks/use-stream-store";
import { BlockRenderersProvider } from "@/features/session-kernel/plugins/mounts/use-block-renderers";
import type { Message, StreamChunk } from "@/types";
import { MessageView } from "./message-view";
import { StreamingMessage } from "./streaming-message";

const { listSessionPlugins } = vi.hoisted(() => ({ listSessionPlugins: vi.fn() }));
vi.mock("@/features/session-kernel/plugins/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/session-kernel/plugins/registry")>()),
  listSessionPlugins,
}));

/** 与日志面板同构：订阅日志版本号（日志面板正是这样被每条日志同步刷新的）。 */
function LogSubscriber() {
  useSyncExternalStore(subscribeDevLogs, devLogVersion, devLogVersion);
  return null;
}

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

/**
 * 先挂订阅组件、再在同一个 React 根里重渲染出被测组件树。
 * React 的「渲染一个组件时更新另一个组件」只在同一个根渲染到一半被更新时才报——
 * 订阅组件放在另一个根里抓不到（对照实测：把日志放回渲染函数，测试照样通过）。
 */
function mountSubscriberThen(ui: () => ReactNode) {
  const view = render(<LogSubscriber />);
  const seq = lastSeq();
  view.rerender(
    <>
      <LogSubscriber />
      {ui()}
    </>,
  );
  return { seq, ...view };
}

/** 渲染期间写日志时 React 的报错（「渲染一个组件时更新另一个组件」）。 */
const renderTimeUpdateErrors = () =>
  consoleError.mock.calls.filter((args) => String(args[0]).includes("while rendering a different component"));

/** 最新一条日志的序号（还没有日志时为 0）。 */
const lastSeq = () => {
  const all = getDevLogs();
  return all.length ? all[all.length - 1].seq : 0;
};

/** 从 from 之后新写入的日志的消息名。 */
const messagesAfter = (from: number) => getDevLogs().filter((entry) => entry.seq > from).map((entry) => entry.message);

const interaction = (prompt: string): Message["content"][number] => ({
  type: "interaction",
  prompt,
  options: [{ option_id: "a", label: "甲" }, { option_id: "b", label: "乙" }],
  answer: "甲",
});

const messages: Message[] = [
  { role: "user", timestamp: null, content: [interaction("用户侧选一个")] },
  {
    role: "assistant",
    timestamp: null,
    content: [
      { type: "text", text: "```mermaid\ngraph TD; A-->B\n```" },
      interaction("助手侧选一个"),
      { type: "text", text: "完成" },
    ],
  },
];

const sessionId = "session-render-time-devlog";
const chunk = (data: StreamChunk["data"]): StreamChunk => ({ session_id: sessionId, event_type: data.kind, data });

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  consoleError.mockClear();
  listSessionPlugins.mockReturnValue([
    {
      id: "session.fake",
      source: "config",
      mounts: [
        {
          kind: "block-renderer",
          matching: "code",
          languages: ["mermaid"],
          detect: () => true,
          pluginId: "fake",
          pluginLabel: "Fake",
          Component: () => null,
        },
      ],
    },
  ]);
});

afterEach(() => {
  streamStore.drop(sessionId);
});

describe("渲染期间不写开发日志", () => {
  it("消息视图树（轮次分组 / 问答卡 / 用户侧与助手侧 / 代码块被插件接管）", () => {
    const { seq } = mountSubscriberThen(() => (
      <BlockRenderersProvider enabled={new Set(["session.fake"])}>
        <MessageView messages={messages} flat />
      </BlockRenderersProvider>
    ));
    // 助手侧的问答卡在「已工作」折叠组里，展开后才渲染
    fireEvent.click(screen.getByRole("button", { name: /已工作/ }));
    expect(renderTimeUpdateErrors()).toEqual([]);
    const logged = messagesAfter(seq);
    // 诊断信息都在，只是改到提交之后写
    for (const expected of [
      "ia-render:turngroup",
      "ia-card",
      "ia-render:user-group",
      "ia-render:assistant-group",
      "block-renderer hit: mermaid → fake",
    ]) {
      expect(logged, expected).toContain(expected);
    }
  });

  it("流式消息里的问答卡", () => {
    streamStore.start(sessionId, null);
    streamStore.push(sessionId, chunk({ kind: "text_delta", delta: "先确认一下" }));
    streamStore.push(
      sessionId,
      chunk({
        kind: "interaction_request",
        request_id: "req-1",
        prompt: "流式侧选一个",
        options: [],
        allow_multiple: false,
        allow_custom_text: true,
        required: true,
      }),
    );
    streamStore.recordInteractionResponse(sessionId, "req-1", "甲");
    const { seq } = mountSubscriberThen(() => <StreamingMessage sessionId={sessionId} />);
    expect(renderTimeUpdateErrors()).toEqual([]);
    expect(messagesAfter(seq)).toContain("ia-render:stream-part");
  });
});
