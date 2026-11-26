/**
 * 搜索态的边界——v0.9.8 评审修复轮 R2，对应 tests/V-用例清单第四节（V-2）：
 * 命中行有上限（V2-U3～U5）、一次提交只上色一次（V2-U6）、进出搜索不重新挂载已显示的行（V2-U8）。
 *
 * 工具目录用替身（本文件不涉及工具标签，只是不走后端请求）；高亮接口用最小替身。
 */
import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/types";
import { MessageView } from "./message-view";
import { stubTextHighlightApi } from "./__stubs__/text-highlight-api";
import { catalogStub } from "./__stubs__/tool-catalog";

vi.mock("@/lib/tool-catalog", async () => await import("./__stubs__/tool-catalog"));

const user = (text: string): Message => ({ role: "user", timestamp: null, content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({ role: "assistant", timestamp: null, content: [{ type: "text", text }] });

/** 205 轮对话：每轮用户消息含关键词、助手回复不含。搜索态命中行 = 205 条用户行。 */
const LONG: Message[] = Array.from({ length: 205 }, (_, i) => [user(`关键词 第 ${i} 问`), assistant(`第 ${i} 个回复`)]).flat();

const rowsIn = (container: HTMLElement) => container.querySelectorAll("[data-message-index]").length;

beforeAll(async () => {
  await i18n.changeLanguage("zh");
  Element.prototype.scrollIntoView ??= vi.fn();
  Element.prototype.scrollTo ??= vi.fn();
});

beforeEach(() => {
  catalogStub.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("命中行有上限", () => {
  it("超过上限：只渲染前 200 行命中，末尾「显示更多」写明还有几条；点一次多一批，点完消失——V2-U3", () => {
    const api = stubTextHighlightApi();
    const view = render(<MessageView messages={LONG} sessionId="s1" flat searchQuery="关键词" />);
    expect(rowsIn(view.container)).toBe(200);
    const more = screen.getByRole("button", { name: "显示更多命中的消息（还有 5 条）" });
    expect(more.getAttribute("data-search-more")).toBe("5");
    // 上限之前的细条照常；最后一条之后不再是「会话到此为止」
    expect(screen.getAllByText("中间省略 1 条消息")).toHaveLength(199);
    expect(screen.queryByText(/后面省略/)).toBeNull();

    fireEvent.click(more);
    expect(rowsIn(view.container)).toBe(205);
    expect(screen.queryByRole("button", { name: /显示更多/ })).toBeNull();
    expect(api.highlights.get("jishu-search-match")!.ranges).toHaveLength(204);
    expect(api.highlights.get("jishu-search-current")!.ranges).toHaveLength(1);
  });

  it("上限生效时计数只数显示出来的行——V2-U4", () => {
    const onSearchStatusChange = vi.fn();
    const view = render(<MessageView messages={LONG} sessionId="s1" flat searchQuery="关键词" onSearchStatusChange={onSearchStatusChange} />);
    expect(onSearchStatusChange).toHaveBeenLastCalledWith({ current: 1, total: 200 });
    // 翻到最后一个命中：落在第 200 条显示出来的行上，不是没渲染的行
    view.rerender(
      <MessageView messages={LONG} sessionId="s1" flat searchQuery="关键词" searchNavigation={{ direction: -1, nonce: 1 }} onSearchStatusChange={onSearchStatusChange} />,
    );
    expect(onSearchStatusChange).toHaveBeenLastCalledWith({ current: 200, total: 200 });
    // 点「显示更多」：新增的命中接在后面，原来正看的第 200 处不动（二轮评审 R3 P2-9：修前跳回第 1 处）
    fireEvent.click(screen.getByRole("button", { name: /显示更多/ }));
    expect(onSearchStatusChange).toHaveBeenLastCalledWith({ current: 200, total: 205 });
  });

  it("换一个搜索词后上限回到默认——V2-U5", () => {
    const view = render(<MessageView messages={LONG} sessionId="s1" flat searchQuery="关键词" />);
    fireEvent.click(screen.getByRole("button", { name: /显示更多/ }));
    expect(rowsIn(view.container)).toBe(205);
    view.rerender(<MessageView messages={LONG} sessionId="s1" flat searchQuery="关键词 第 1" />);
    expect(rowsIn(view.container)).toBe(111);
    view.rerender(<MessageView messages={LONG} sessionId="s1" flat searchQuery="关键词" />);
    expect(rowsIn(view.container)).toBe(200);
  });

  it("没到上限的会话与原先完全一致：全部命中行都显示，没有「显示更多」", () => {
    const messages = [user("关键词 一"), assistant("回复"), user("关键词 二"), assistant("回复"), user("关键词 三")];
    const view = render(<MessageView messages={messages} sessionId="s1" flat searchQuery="关键词" />);
    expect(rowsIn(view.container)).toBe(3);
    expect(screen.queryByRole("button", { name: /显示更多/ })).toBeNull();
    // 首尾都是命中：没有前、后细条，只有两条中间细条
    expect(screen.queryByText(/前面省略|后面省略/)).toBeNull();
    expect(screen.getAllByText("中间省略 1 条消息")).toHaveLength(2);
  });
});

describe("一次提交只上色一次", () => {
  const messages = [user("关键词 甲"), assistant("关键词 乙"), user("关键词 丙")];

  it("3 个文字块命中：挂载时上色 2 次（命中层、当前层）；翻页后再 2 次；无关重渲染不再上色——V2-U6", () => {
    const api = stubTextHighlightApi();
    const view = render(<MessageView messages={messages} sessionId="s1" flat searchQuery="关键词" />);
    expect(api.highlights.get("jishu-search-match")!.ranges).toHaveLength(2);
    expect(api.highlights.get("jishu-search-current")!.ranges).toHaveLength(1);
    expect(api.setCalls()).toBe(2);

    view.rerender(<MessageView messages={messages} sessionId="s1" flat searchQuery="关键词" searchNavigation={{ direction: 1, nonce: 1 }} />);
    expect(api.setCalls()).toBe(4);
    expect(api.highlights.get("jishu-search-current")!.ranges).toHaveLength(1);

    view.rerender(<MessageView messages={messages} sessionId="s1" flat searchQuery="关键词" expandSignal={1} />);
    expect(api.setCalls()).toBe(4);
  });

  it("清空关键词后高亮撤干净；视图卸载后两层也为空", () => {
    const api = stubTextHighlightApi();
    const view = render(<MessageView messages={messages} sessionId="s1" flat searchQuery="关键词" />);
    view.rerender(<MessageView messages={messages} sessionId="s1" flat searchQuery="" />);
    expect(api.highlights.get("jishu-search-match")!.ranges).toHaveLength(0);
    expect(api.highlights.get("jishu-search-current")!.ranges).toHaveLength(0);
    view.rerender(<MessageView messages={messages} sessionId="s1" flat searchQuery="关键词" />);
    view.unmount();
    expect(api.highlights.get("jishu-search-match")!.ranges).toHaveLength(0);
    expect(api.highlights.get("jishu-search-current")!.ranges).toHaveLength(0);
  });
});

describe("进出搜索时不重新挂载已显示的行", () => {
  const messages = [user("你好"), assistant("关键词 在这里"), user("第二问")];

  it("退出搜索：搜索态里显示着的那一行，列表展开后还是同一个 DOM 节点——V2-U8", () => {
    const view = render(<MessageView messages={messages} sessionId="s1" flat searchQuery="关键词" />);
    expect(rowsIn(view.container)).toBe(1);
    const hitRow = view.container.querySelector('[data-message-index="1"]');
    view.rerender(<MessageView messages={messages} sessionId="s1" flat searchQuery="" />);
    expect(rowsIn(view.container)).toBe(3);
    expect(view.container.querySelector('[data-message-index="1"]')).toBe(hitRow);
  });

  it("进入搜索：常态下显示着的行，搜索态里还是同一个 DOM 节点", () => {
    const view = render(<MessageView messages={messages} sessionId="s1" flat />);
    const hitRow = view.container.querySelector('[data-message-index="1"]');
    view.rerender(<MessageView messages={messages} sessionId="s1" flat searchQuery="关键词" />);
    expect(rowsIn(view.container)).toBe(1);
    expect(view.container.querySelector('[data-message-index="1"]')).toBe(hitRow);
  });

  it("换搜索词时已在页面上的命中行不重新挂载", () => {
    const many = [user("蓝鲸 一"), assistant("回复"), user("蓝鲸 海豹 二"), assistant("回复"), user("海豹 三")];
    const view = render(<MessageView messages={many} sessionId="s1" flat searchQuery="蓝鲸" />);
    const shared = view.container.querySelector('[data-message-index="2"]');
    view.rerender(<MessageView messages={many} sessionId="s1" flat searchQuery="海豹" />);
    expect(view.container.querySelector('[data-message-index="2"]')).toBe(shared);
  });
});

/**
 * 开发模式下 StrictMode 会在挂载后把效果重放一遍（每个副作用先收尾、再重做）。高亮是
 * 各文字块登记、视图统一上色的，重放之后登记与上色都要还在——应用入口就包着 StrictMode。
 */
describe("效果重放（StrictMode）", () => {
  const messages = [user("关键词 甲"), assistant("关键词 乙"), user("关键词 丙")];

  it("挂载后效果被重放一遍：高亮仍在、计数不变", () => {
    const api = stubTextHighlightApi();
    const onSearchStatusChange = vi.fn();
    render(
      <StrictMode>
        <MessageView messages={messages} sessionId="s1" flat searchQuery="关键词" onSearchStatusChange={onSearchStatusChange} />
      </StrictMode>,
    );
    expect(onSearchStatusChange).toHaveBeenLastCalledWith({ current: 1, total: 3 });
    expect(api.highlights.get("jishu-search-match")!.ranges).toHaveLength(2);
    expect(api.highlights.get("jishu-search-current")!.ranges).toHaveLength(1);
  });

  it("重放后翻页、清空关键词照常", () => {
    const api = stubTextHighlightApi();
    const view = (searchQuery: string, navigation?: { direction: 1 | -1; nonce: number }) => (
      <StrictMode>
        <MessageView messages={messages} sessionId="s1" flat searchQuery={searchQuery} searchNavigation={navigation} />
      </StrictMode>
    );
    const utils = render(view("关键词"));
    utils.rerender(view("关键词", { direction: 1, nonce: 1 }));
    expect(api.highlights.get("jishu-search-current")!.ranges).toHaveLength(1);
    utils.rerender(view(""));
    expect(api.highlights.get("jishu-search-match")!.ranges).toHaveLength(0);
    expect(api.highlights.get("jishu-search-current")!.ranges).toHaveLength(0);
  });
});

/** 消息视图的根带作用域类名——样式表里给这个范围内的文字选区配色（tests/V-用例清单 V3-U3）。 */
describe("消息视图的作用域", () => {
  it("根容器带 message-stream", () => {
    const { container } = render(<MessageView messages={[user("你好")]} sessionId="s1" flat />);
    expect(container.querySelector(".message-stream")).toBeTruthy();
    expect(container.querySelector(".message-stream [data-message-index]")).toBeTruthy();
  });
});
