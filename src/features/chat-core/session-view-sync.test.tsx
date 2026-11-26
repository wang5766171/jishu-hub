/**
 * v0.9.8 评审修复轮 R2（S 域，S-17）：按会话提交消息与「删除未送达」。
 * 对应 tests/S-用例清单 S17-U1、S17-U2。
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject, SetStateAction } from "react";

import type { Message } from "@/types";
import {
  deleteCachedSessionMessages,
  getCachedSessionMessages,
  setCachedSessionMessages,
} from "@/features/session-kernel/kernel/session-cache";
import {
  commitSessionMessages,
  removeUnsentMessage,
  useUnsentMessageDismiss,
} from "./session-view-sync";

const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));

const user = (text: string, timestamp: number | null = 1): Message => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});
const unsent = (text: string, sentAt: number): Message => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: sentAt,
  unsent: true,
} as Message);

const CACHED: Message[] = [user("第一问"), user("第二问"), unsent("没送出去的", 5000)];

/** 正文的 setter（选中会话的消息视图）——每个用例前清一次调用记录。 */
const setSessionMessages = vi.fn<(value: SetStateAction<Message[]>) => void>();

describe("评审修复轮 R2：删除未送达的数据只来自该会话的缓存", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeCommand.mockReset();
    deleteCachedSessionMessages("s1");
    deleteCachedSessionMessages("s2");
    setSessionMessages.mockClear();
  });

  it("S17-U1 回执前切到别的会话：该会话的缓存已去掉这条，正文不被改写", async () => {
    setCachedSessionMessages("s1", CACHED);
    setCachedSessionMessages("s2", [user("s2 的问题")]);
    let finish: () => void = () => {};
    invokeCommand.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const selectedSessionRef = { current: "s1" } as MutableRefObject<string | null>;
    const dismiss = renderDismiss(selectedSessionRef);

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = dismiss(unsent("没送出去的", 5000));
    });
    expect(invokeCommand).toHaveBeenCalledWith("dismiss_pending_message", { sessionId: "s1", sentAt: 5000 });

    // IPC 往返期间用户切到 s2，随后回执到达
    selectedSessionRef.current = "s2";
    await act(async () => {
      finish();
      await pending;
    });

    expect(getCachedSessionMessages("s1")?.map((m) => m.content[0])).toEqual([
      { type: "text", text: "第一问" },
      { type: "text", text: "第二问" },
    ]);
    expect(getCachedSessionMessages("s2")).toEqual([user("s2 的问题")]);
    expect(setSessionMessages).not.toHaveBeenCalled();
  });

  it("仍选中该会话：缓存与正文同步去掉这一条", async () => {
    setCachedSessionMessages("s1", CACHED);
    invokeCommand.mockResolvedValue(undefined);
    const dismiss = renderDismiss({ current: "s1" } as MutableRefObject<string | null>);

    await act(async () => {
      await dismiss(unsent("没送出去的", 5000));
    });

    expect(setSessionMessages).toHaveBeenCalledTimes(1);
    const shown = setSessionMessages.mock.calls[0][0] as Message[];
    expect(shown).toHaveLength(2);
    expect(shown).toBe(getCachedSessionMessages("s1"));
  });

  it("后端删除失败：本地不动", async () => {
    setCachedSessionMessages("s1", CACHED);
    invokeCommand.mockRejectedValue(new Error("db locked"));
    const dismiss = renderDismiss({ current: "s1" } as MutableRefObject<string | null>);

    await act(async () => {
      await dismiss(unsent("没送出去的", 5000));
    });

    expect(getCachedSessionMessages("s1")).toBe(CACHED);
    expect(setSessionMessages).not.toHaveBeenCalled();
  });

  it("S17-U2 提交某个会话的消息：缓存一定写；正文只在仍选中它时写", () => {
    const messages = [user("新的一份")];
    const away = { selectedSessionRef: { current: "s2" } as MutableRefObject<string | null>, setSessionMessages };
    commitSessionMessages("s1", messages, away);
    expect(getCachedSessionMessages("s1")).toBe(messages);
    expect(setSessionMessages).not.toHaveBeenCalled();

    const viewing = { selectedSessionRef: { current: "s1" } as MutableRefObject<string | null>, setSessionMessages };
    commitSessionMessages("s1", messages, viewing);
    expect(setSessionMessages).toHaveBeenCalledWith(messages);
  });

  it("removeUnsentMessage：只去掉「未送达」且发送时刻相同的那一条", () => {
    const same = unsent("没送出去的", 5000);
    const delivered = { ...unsent("已送达的", 5000), unsent: false } as Message;
    const other = unsent("另一条", 6000);
    expect(removeUnsentMessage([same, delivered, other, user("普通")], 5000)).toEqual([delivered, other, user("普通")]);
  });
});

function renderDismiss(selectedSessionRef: MutableRefObject<string | null>) {
  let latest: ReturnType<typeof useUnsentMessageDismiss> = () => Promise.resolve();
  function Harness() {
    latest = useUnsentMessageDismiss({ selectedSessionRef, setSessionMessages });
    return null;
  }
  render(<Harness />);
  return (msg: Message) => latest(msg);
}
