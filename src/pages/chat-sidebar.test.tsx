/**
 * 会话侧栏单测——v0.9.8 需求23 补充轮，对应 tests/06-测试清单：
 * S23-U27 「进入会话」的两个入口（搜索态才有的双击 / 右键菜单）与悬停完整标题。
 *
 * 侧栏里与这条用例无关的重模块（未读、插件注册表、任务树、页面请求）全部替身，只留列表与菜单。
 */
import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatSidebar } from "./chat-sidebar";
import { catalogStub } from "@/components/sessions/__stubs__/tool-catalog";
import type { Session, SessionSearchResult } from "@/types";

vi.mock("@/hooks/use-invoke", () => ({ invokeCommand: vi.fn(async () => false) }));
vi.mock("@/features/session-kernel/session-unread", () => ({ useSessionUnread: () => ({}) }));
vi.mock("@/features/session-kernel/plugins/registry", () => ({ useEnabledSessionPlugins: () => new Set<string>() }));
vi.mock("@/features/session-kernel/shell/menu-page", () => ({ requestMenuPage: vi.fn() }));
vi.mock("@/features/session-kernel/capabilities/composition/loader", () => ({
  composedPlugins: () => [],
  composedVersion: () => 0,
  subscribeComposed: () => () => {},
}));
vi.mock("@/features/task-workspace/sidebar/task-session-tree", () => ({ TaskSessionTree: () => null }));
vi.mock("@/lib/tool-catalog", async () => await import("@/components/sessions/__stubs__/tool-catalog"));

const session = (id: string, name: string): Session => ({
  id,
  path: "",
  messages: [],
  display_name: name,
  started_at: null,
  last_active: null,
});
const sessions = [session("s1", "创建r2-steps与docs文件并补充说明"), session("s2", "身份询问")];

const hit = (sessionId: string): SessionSearchResult => ({
  sessionId,
  matchCount: 3,
  previewText: "……蓝鲸……",
  firstMatchIndex: 0,
});

const noop = () => {};
const ref = { current: null };

function mount({ query = "", results = [] as SessionSearchResult[] } = {}) {
  const handleSelectSession = vi.fn();
  const onEnterSession = vi.fn();
  const setSearchQuery = vi.fn();
  render(
    <ChatSidebar
      currentProject={{ name: "jishu-hub", path: "D:/p", encoded_name: "D--p", session_count: 2, last_active: null, has_claude_md: false, initialized: true } as never}
      projectDisplayName="jishu-hub"
      projectId="D--p"
      projectPath="D:/p"
      sidebarCollapsed={false}
      setSidebarCollapsed={noop}
      taskLaunchOpen={false}
      searchQuery={query}
      setSearchQuery={setSearchQuery}
      showMessageSearchControls={Boolean(query)}
      messageSearchLabel={query ? "1/3" : "0/0"}
      messageSearchTotal={query ? 3 : 0}
      requestMessageSearchNavigation={noop}
      searchResults={results}
      displaySessions={query ? sessions.filter((s) => results.some((r) => r.sessionId === s.id)) : sessions}
      sessionNames={null}
      selectedSession={null}
      streamingSessionIds={[]}
      refreshingSessionId={null}
      regularSessionsOpen
      setRegularSessionsOpen={() => true}
      canForkSession={false}
      canDeleteSession={false}
      forking={false}
      displayTaskLaunchSessions={[]}
      activeTaskInstanceId={null}
      activeTaskInstanceIdRef={ref}
      findTaskInstance={() => null}
      openTaskSession={noop}
      handleTaskCancelRun={noop}
      setTaskLaunchSessions={noop}
      confirmDialog={async () => true}
      handleNewSession={noop}
      handleRefresh={noop}
      handleOpenTaskConversation={noop}
      onLaunchMenuPlugin={noop}
      handleSelectSession={handleSelectSession}
      onEnterSession={onEnterSession}
      handleFloatSession={noop}
      handleResumeSession={noop}
      handleForkSession={noop}
      handleDeleteSession={noop}
      handleRefreshSession={noop}
      setRenameOpen={noop}
      setRenameTaskTarget={noop}
    />,
  );
  return { handleSelectSession, onEnterSession, setSearchQuery };
}

const row = (name: string) => screen.getByRole("button", { name: new RegExp(name) });
/** React 的 onDoubleClick 监听的是 dblclick 事件（testing-library 的 doubleClick 只发 click）。 */
const dblclick = (el: HTMLElement) => fireEvent(el, new MouseEvent("dblclick", { bubbles: true, cancelable: true }));

beforeAll(async () => {
  await i18n.changeLanguage("zh");
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("会话侧栏 · 进入会话——S23-U27", () => {
  it("搜索时双击结果行：触发「进入会话」；单击仍是打开会话", () => {
    const m = mount({ query: "蓝鲸", results: [hit("s1")] });
    const target = row("创建r2-steps");
    dblclick(target);
    expect(m.onEnterSession).toHaveBeenCalledTimes(1);
    expect(m.onEnterSession).toHaveBeenCalledWith("s1");
    fireEvent.click(target);
    expect(m.handleSelectSession).toHaveBeenCalledWith("s1");
    expect(m.onEnterSession).toHaveBeenCalledTimes(1);
  });

  it("不搜索时双击会话行：不触发「进入会话」——S23-G21", () => {
    const m = mount();
    dblclick(row("创建r2-steps"));
    expect(m.onEnterSession).not.toHaveBeenCalled();
    fireEvent.click(row("身份询问"));
    expect(m.handleSelectSession).toHaveBeenCalledWith("s2");
  });

  it("搜索时右键结果行：菜单里有「进入会话」，点了就触发", () => {
    const m = mount({ query: "蓝鲸", results: [hit("s1")] });
    fireEvent.contextMenu(row("创建r2-steps"), { button: 2, clientX: 120, clientY: 160 });
    const item = screen.getByRole("menuitem", { name: "进入会话" });
    fireEvent.click(item);
    expect(m.onEnterSession).toHaveBeenCalledWith("s1");
    expect(m.handleSelectSession).not.toHaveBeenCalled();
  });

  it("不搜索时右键会话行：菜单里没有「进入会话」——S23-G21", () => {
    mount();
    fireEvent.contextMenu(row("身份询问"), { button: 2, clientX: 120, clientY: 200 });
    expect(screen.queryByRole("menuitem", { name: "进入会话" })).toBeNull();
    // 菜单本身是开着的（原有的项在）
    expect(screen.getByRole("menuitem", { name: /悬浮窗口/ })).toBeTruthy();
  });

  it("会话标题带完整标题的悬停提示——S23-G17", () => {
    mount();
    const title = row("创建r2-steps").querySelector("span.truncate[title]");
    expect(title?.getAttribute("title")).toBe("创建r2-steps与docs文件并补充说明");
  });
});

/** 「进入会话」的说法与项目卡上的那一个一致——v0.9.8 评审修复轮 R2（tests/V-用例清单 V6-U3）。 */
describe("会话侧栏 · 「进入会话」的说法一致", () => {
  afterEach(async () => {
    await i18n.changeLanguage("zh");
  });

  it("中英文都与 projects.enterChat 是同一个说法——V6-U3", async () => {
    expect(i18n.t("sessions.enterSession")).toBe(i18n.t("projects.enterChat"));
    await i18n.changeLanguage("en");
    expect(i18n.t("sessions.enterSession")).toBe("Enter Chat");
    expect(i18n.t("projects.enterChat")).toBe("Enter Chat");
  });

  it("英文下右键菜单项是 Enter Chat", async () => {
    await i18n.changeLanguage("en");
    mount({ query: "蓝鲸", results: [hit("s1")] });
    fireEvent.contextMenu(row("创建r2-steps"), { button: 2, clientX: 120, clientY: 160 });
    expect(screen.getByRole("menuitem", { name: "Enter Chat" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Open session" })).toBeNull();
  });
});

/** 侧栏搜索认得出消息里的工具标签——v0.9.8 评审修复轮 R2（tests/V-用例清单 V9-U5）。 */
describe("会话侧栏 · 工具目录", () => {
  beforeEach(() => {
    catalogStub.reset();
  });

  it("侧栏一挂上就用到工具目录：会话还没打开过，搜索也认得出消息里的标签", () => {
    mount();
    expect(catalogStub.ensured).toHaveLength(1);
    expect(catalogStub.ensured[0]).toBeNull();
  });
});
