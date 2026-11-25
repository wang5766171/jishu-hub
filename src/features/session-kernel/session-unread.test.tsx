/**
 * 「正在查看 = 已读」的判定点——v0.9.8 需求24，对应 tests/06-测试清单 S24-U1~U6。
 *
 * 背景：会话未读（绿 / 红点）的清除原来只写在常规会话的打开函数里；任务会话的打开
 * 走另一条路（直接改选中态），没人清——点开任务行时绿点只是因为「这一行正被选中」
 * 暂时不显示，切到别的会话又出现。
 */
import { act, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachWindowActivityTracking } from "./window-activity";
import { clearUnread, getUnread, setUnread, useUnreadClearedOnView } from "./session-unread";

const known = ["s1", "s2"];

type Handle = { select: (next: string | null) => void };

/**
 * 选中态由测试直接改，不经任何「打开会话」的函数——任务行的打开方式就是这样，
 * 这个判定点也正因为此才不能挂在打开函数上。
 */
function mount({ withRule }: { withRule: boolean }): Handle {
  let select: Handle["select"] = () => {};
  function Probe() {
    const [selected, setSelected] = useState<string | null>(null);
    if (withRule) useUnreadClearedOnView(selected);
    select = setSelected;
    return null;
  }
  render(<Probe />);
  return {
    select: (next) => {
      act(() => {
        select(next);
      });
    },
  };
}

beforeEach(() => {
  for (const id of known) clearUnread(id);
});

afterEach(() => {
  for (const id of known) clearUnread(id);
});

describe("v0.9.8 需求24：正在查看的会话 = 已读", () => {
  it("选中态切到某个会话，它的未读被清除——S24-U1", () => {
    const h = mount({ withRule: true });
    h.select("s2");
    setUnread("s1", "done");
    expect(getUnread("s1")).toBe("done");

    h.select("s1");
    expect(getUnread("s1")).toBeUndefined();
  });

  it("任务会话：选中态被直接改（任务行的打开方式），同样清除——S24-U2", () => {
    // 修复前：任务行点开时只有「这一行正被选中」把绿点挡住，未读记录还在——切走又出现
    const h = mount({ withRule: true });
    setUnread("s1", "done");

    h.select("s1");
    // 切到别的会话（离开任务）——未读已经清掉，不会再出现
    h.select("s2");
    expect(getUnread("s1")).toBeUndefined();
  });

  it("占位选中态（没有打开会话）不清任何未读——S24-U3", () => {
    const h = mount({ withRule: true });
    setUnread("s1", "done");
    setUnread("s2", "failed");

    h.select("new");
    h.select("pending-node");
    h.select(null);

    expect(getUnread("s1")).toBe("done");
    expect(getUnread("s2")).toBe("failed");
  });

  it("只清正在查看的那一个——S24-U4", () => {
    const h = mount({ withRule: true });
    setUnread("s1", "done");
    setUnread("s2", "done");

    h.select("s1");

    expect(getUnread("s1")).toBeUndefined();
    expect(getUnread("s2")).toBe("done");
  });

  it("窗口重新激活时，正在查看的会话算看过；没在看的不动——S24-U5", () => {
    const h = mount({ withRule: true });
    h.select("s1");
    const detach = attachWindowActivityTracking();
    try {
      // 用户在别的应用里：两个会话的回合都结束了（窗口没激活，所以照常记未读）
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      setUnread("s1", "done");
      setUnread("s2", "done");
      expect(getUnread("s1")).toBe("done");
      expect(getUnread("s2")).toBe("done");

      // 回到窗口：正看着 s1，它的结果已经在眼前
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(getUnread("s1")).toBeUndefined();
      expect(getUnread("s2")).toBe("done");
    } finally {
      detach();
    }
  });

  it("对照：不挂这个判定点时未读保留——S24-U6", () => {
    const h = mount({ withRule: false });
    setUnread("s1", "done");

    h.select("s1");

    expect(getUnread("s1")).toBe("done");
  });
});
