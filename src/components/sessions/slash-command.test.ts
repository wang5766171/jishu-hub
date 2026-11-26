// v0.9.8 需求7 补充轮：斜杠命令规则单点——面板选中只填入、发送时才决定去向。
// 评审修复轮 R2（S 域）：内建命令名单单一出处、去向判断看 available、扩展命令识别。
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_SLASH_COMMANDS,
  dispatchLocalSlashCommand,
  findExtensionSlashCommand,
  findLocalSlashCommand,
  findSlashCommandEntry,
  formatSlashCommand,
  isLocalSlashCommandName,
  parseSlashCommand,
} from "./slash-command";
import { stagedCompactionArgs } from "@/lib/slash-command-parse";

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

// ── v0.9.8 评审修复轮 R2（S 域）────────────────────────────────────────────

describe("评审修复轮 R2：内建命令名单单一出处", () => {
  it("S7-U1 名单里的每个名字都有执行器，各自触发一次", async () => {
    const handlers = makeHandlers();
    for (const name of LOCAL_SLASH_COMMANDS) {
      expect(await dispatchLocalSlashCommand(name, "", handlers)).toBe(true);
    }
    expect(handlers.rename).toHaveBeenCalledTimes(1);
    expect(handlers.openTerminal).toHaveBeenCalledTimes(1);
    expect(handlers.float).toHaveBeenCalledTimes(1);
    expect(handlers.compact).toHaveBeenCalledTimes(1);
    expect(handlers.fork).toHaveBeenCalledTimes(1);
  });

  it("S7-U4 重名去重覆盖全部内建名", () => {
    for (const name of LOCAL_SLASH_COMMANDS) expect(isLocalSlashCommandName(name)).toBe(true);
    expect(isLocalSlashCommandName("todos")).toBe(false);
    expect(isLocalSlashCommandName("compactx")).toBe(false);
    expect(isLocalSlashCommandName("")).toBe(false);
  });
});

describe("评审修复轮 R2：去向判断看 available", () => {
  it("S7-U2 不可用的内建命令不算「可本地执行」；清单项仍能命中（用于给出提示）", () => {
    const commands = [
      ...COMMANDS.filter((c) => c.name !== "compact"),
      { name: "compact", label: "压缩上下文", available: false, local: true },
    ];
    expect(findLocalSlashCommand("/compact", commands)).toBeNull();
    expect(findSlashCommandEntry("/compact", commands)).toMatchObject({ name: "compact", local: true, available: false });
    // 可用时照常
    expect(findLocalSlashCommand("/compact", COMMANDS)).toEqual({ name: "compact", args: "" });
  });

  it("同名时 hub 内建命令优先", () => {
    const commands = [
      { name: "todos", label: "扩展", available: true, source: "extension" as const },
      { name: "todos", label: "内建", available: true, local: true },
    ];
    expect(findSlashCommandEntry("/todos", commands)).toMatchObject({ local: true });
    expect(findExtensionSlashCommand("/todos", commands)).toBeNull();
  });
});

describe("评审修复轮 R2：扩展命令识别（C1）", () => {
  const EXT: Array<{ name: string; label: string; available: boolean; source: "extension" | "prompt" | "skill" }> = [
    { name: "todos", label: "待办", available: true, source: "extension" },
    { name: "tpl-x", label: "模板", available: true, source: "prompt" },
    { name: "skill:y", label: "技能", available: true, source: "skill" },
    { name: "off", label: "停用", available: false, source: "extension" },
  ];

  it("S1-U1 只认 source 为 extension 且可用", () => {
    expect(findExtensionSlashCommand("/todos", EXT)).toEqual({ name: "todos", args: "" });
    expect(findExtensionSlashCommand("/todos 参数", EXT)).toEqual({ name: "todos", args: "参数" });
    expect(findExtensionSlashCommand("/tpl-x 参数", EXT)).toBeNull();
    expect(findExtensionSlashCommand("/skill:y 参数", EXT)).toBeNull();
    expect(findExtensionSlashCommand("/off", EXT)).toBeNull();
    expect(findExtensionSlashCommand("/unknown", EXT)).toBeNull();
    expect(findExtensionSlashCommand("/todos", undefined)).toBeNull();
  });
});

describe("评审修复轮 R2：排队的压缩条目（C3）", () => {
  it("S2-U9 stagedCompactionArgs：压缩条目 → 补充要求；其余 → null", () => {
    expect(stagedCompactionArgs({ kind: "compaction", content: "/compact" })).toBe("");
    expect(stagedCompactionArgs({ kind: "compaction", content: "/compact 只保留接口设计" })).toBe("只保留接口设计");
    expect(stagedCompactionArgs({ kind: "compaction", content: "你好" })).toBeNull();
    expect(stagedCompactionArgs({ content: "/compact" })).toBeNull();
  });

  it("formatSlashCommand：命令原文的还原", () => {
    expect(formatSlashCommand("compact", null)).toBe("/compact");
    expect(formatSlashCommand("compact", "")).toBe("/compact");
    expect(formatSlashCommand("compact", "只保留接口设计")).toBe("/compact 只保留接口设计");
    // 往返：排队条目的原文再解析回补充要求
    expect(parseSlashCommand(formatSlashCommand("compact", "只保留目标\n不要过程"))).toEqual({
      name: "compact",
      args: "只保留目标\n不要过程",
    });
  });
});
