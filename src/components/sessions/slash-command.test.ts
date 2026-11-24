// v0.9.8 需求7 补充轮：斜杠命令规则单点——面板选中只填入、发送时才决定去向。
import { describe, expect, it, vi } from "vitest";
import { dispatchLocalSlashCommand, findLocalSlashCommand, parseSlashCommand } from "./slash-command";

const COMMANDS = [
  { name: "name", label: "重命名会话", available: true, local: true },
  { name: "terminal", label: "在终端中打开会话", available: true, local: true },
  { name: "float", label: "悬浮窗口", available: true, local: true },
  { name: "compact", label: "压缩上下文", available: true, local: true },
  { name: "fork", label: "创建会话分支", available: true, local: true },
  { name: "skill:jishu-cli-guide", label: "命令行指南", available: true },
];

function makeHandlers() {
  return { rename: vi.fn(), openTerminal: vi.fn(), float: vi.fn(), compact: vi.fn(), fork: vi.fn() };
}

describe("parseSlashCommand", () => {
  it("只有命令名：参数为空串", () => {
    expect(parseSlashCommand("/compact")).toEqual({ name: "compact", args: "" });
  });

  it("命令名 + 参数：参数原样保留（多行也保留，只去首尾空白）", () => {
    expect(parseSlashCommand("/compact 只保留接口设计")).toEqual({ name: "compact", args: "只保留接口设计" });
    expect(parseSlashCommand("  /compact\n只保留目标\n不要过程  ")).toEqual({ name: "compact", args: "只保留目标\n不要过程" });
  });

  it("不是「/名字」开头的文本 → null", () => {
    expect(parseSlashCommand("你好")).toBeNull();
    expect(parseSlashCommand("/")).toBeNull();
    expect(parseSlashCommand("/ compact")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });
});

describe("findLocalSlashCommand（发送时的去向判断）", () => {
  it("UC-3 文本是清单里的 hub 内建命令 → 本地执行", () => {
    expect(findLocalSlashCommand("/compact", COMMANDS)).toEqual({ name: "compact", args: "" });
  });

  it("UC-5 `/compact 补充要求` → 本地执行且带上补充要求", () => {
    expect(findLocalSlashCommand("/compact 只保留接口设计", COMMANDS)).toEqual({
      name: "compact",
      args: "只保留接口设计",
    });
  });

  it("UC-7 pi 动态命令、普通消息、不是命令的斜杠文本 → 不算本地命令（照常发给智能体）", () => {
    expect(findLocalSlashCommand("/skill:jishu-cli-guide 你好", COMMANDS)).toBeNull();
    expect(findLocalSlashCommand("帮我看看这个报错", COMMANDS)).toBeNull();
    expect(findLocalSlashCommand("/unknown-command 文本", COMMANDS)).toBeNull();
    expect(findLocalSlashCommand("/compactx", COMMANDS)).toBeNull();
    expect(findLocalSlashCommand("/compact", undefined)).toBeNull();
  });
});

describe("dispatchLocalSlashCommand（UC-6：按命令名分发，参数给对应的执行器）", () => {
  it("/name 标题 → 直接触发改名；/name → 触发改名但标题为 null（打开改名框）", async () => {
    const handlers = makeHandlers();
    await dispatchLocalSlashCommand("name", "新标题", handlers);
    expect(handlers.rename).toHaveBeenCalledWith("新标题");
    await dispatchLocalSlashCommand("name", "", handlers);
    expect(handlers.rename).toHaveBeenLastCalledWith(null);
    expect(handlers.compact).not.toHaveBeenCalled();
  });

  it("/compact 补充要求 / /compact → compact(补充要求) / compact(null)", async () => {
    const handlers = makeHandlers();
    await dispatchLocalSlashCommand("compact", "只保留任务目标", handlers);
    expect(handlers.compact).toHaveBeenLastCalledWith("只保留任务目标");
    await dispatchLocalSlashCommand("compact", "", handlers);
    expect(handlers.compact).toHaveBeenLastCalledWith(null);
  });

  it("/terminal /float /fork → 各自的执行器，各调用一次", async () => {
    const handlers = makeHandlers();
    expect(await dispatchLocalSlashCommand("terminal", "", handlers)).toBe(true);
    expect(await dispatchLocalSlashCommand("float", "", handlers)).toBe(true);
    expect(await dispatchLocalSlashCommand("fork", "", handlers)).toBe(true);
    expect(handlers.openTerminal).toHaveBeenCalledTimes(1);
    expect(handlers.float).toHaveBeenCalledTimes(1);
    expect(handlers.fork).toHaveBeenCalledTimes(1);
    expect(handlers.rename).not.toHaveBeenCalled();
    expect(handlers.compact).not.toHaveBeenCalled();
  });

  it("不是 hub 内建命令 → false，不触发任何执行器", async () => {
    const handlers = makeHandlers();
    expect(await dispatchLocalSlashCommand("skill:jishu-cli-guide", "你好", handlers)).toBe(false);
    for (const fn of Object.values(handlers)) expect(fn).not.toHaveBeenCalled();
  });
});
