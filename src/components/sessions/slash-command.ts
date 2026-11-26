/**
 * 斜杠命令文本规则单点（v0.9.8 需求7 补充轮）。
 *
 * 命令面板里的命令**一律选中只填入输入框**，点发送才决定去向：
 * - hub 内建命令（`local`）由 hub 在本地执行——pi 的 prompt 通道只执行扩展
 *   命令，不执行内建命令；
 * - 扩展命令（`source === "extension"`）发给智能体，由引擎立即执行——不落
 *   用户消息、不起回合（与 pi 原生 TUI 一致）；
 * - 其余（提示模板、技能命令、普通消息）照常发给智能体。
 *
 * v0.9.8 评审修复轮 R2：内建命令名单收成唯一出处 `LOCAL_SLASH_COMMANDS`——
 * 面板清单与分发表都从它派生（分发表按名单的键联合建表，名单加了名字而
 * 没配执行器时类型检查即报错；此前两处各写一份，漏改会静默吞掉输入）。
 */

/** 动态命令的来源（引擎 get_commands 的三源）。 */
export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
  name: string;
  label: string;
  available: boolean;
  /** true = hub 内建命令，发送时本地执行；缺省 = 发送给智能体。 */
  local?: boolean;
  /** 动态命令的来源。extension = 扩展命令：引擎立即执行、不落用户消息、不起回合。 */
  source?: SlashCommandSource;
  /** hub 内建命令当前不可用时的提示文案（与 available 同处给出）。 */
  unavailableHint?: string;
}

// 解析与还原在下层（src/lib/slash-command-parse.ts）：压缩请求与事件管线也要用，
// 下层不能反过来引用组件目录。这里再导出，既有导入方不用改。
import { formatSlashCommand, parseSlashCommand, type ParsedSlashCommand } from "@/lib/slash-command-parse";

export { formatSlashCommand, parseSlashCommand };
export type { ParsedSlashCommand } from "@/lib/slash-command-parse";

/**
 * hub 内建命令名单——唯一出处。面板清单（chat-page）、重名去重、分发表
 * （下方）都从这里派生；新增内建命令只改这里。
 */
export const LOCAL_SLASH_COMMANDS = ["name", "terminal", "float", "compact", "fork"] as const;
export type LocalSlashCommandName = (typeof LOCAL_SLASH_COMMANDS)[number];

/** 这个名字是不是 hub 内建命令（动态命令与任一内建名重名时内建优先）。 */
export function isLocalSlashCommandName(name: string): boolean {
  return (LOCAL_SLASH_COMMANDS as readonly string[]).includes(name);
}

/** 文本命中的清单项（同名时 hub 内建命令优先）；没命中 → null。 */
export function findSlashCommandEntry(
  text: string,
  commands: readonly SlashCommandInfo[] | undefined,
): SlashCommandInfo | null {
  const parsed = parseSlashCommand(text);
  if (!parsed || !commands) return null;
  return commands.find((command) => command.name === parsed.name && command.local)
    ?? commands.find((command) => command.name === parsed.name)
    ?? null;
}

/**
 * 文本是**当前可用**的 hub 内建命令时返回解析结果；否则 null。不可用的
 * 内建命令不算「可本地执行」——面板里不显示的命令，手输也不执行。
 */
export function findLocalSlashCommand(
  text: string,
  commands: readonly SlashCommandInfo[] | undefined,
): ParsedSlashCommand | null {
  const entry = findSlashCommandEntry(text, commands);
  if (!entry?.local || !entry.available) return null;
  return parseSlashCommand(text);
}

/**
 * 文本是扩展命令时返回解析结果。扩展命令由引擎立即执行（正在输出时也是），
 * 不落用户消息、不起回合——发送路径对它单独处理（C1）。
 */
export function findExtensionSlashCommand(
  text: string,
  commands: readonly SlashCommandInfo[] | undefined,
): ParsedSlashCommand | null {
  const entry = findSlashCommandEntry(text, commands);
  if (!entry?.available || entry.source !== "extension") return null;
  return parseSlashCommand(text);
}

/** hub 内建命令的执行器（由页面提供）。 */
export interface LocalSlashCommandHandlers {
  /** `/name 标题` 直接改名；不带标题（null）时打开改名对话框。 */
  rename: (name: string | null) => void | Promise<void>;
  openTerminal: () => void | Promise<void>;
  float: () => void | Promise<void>;
  /** `compact(补充要求)`；`/compact` 后面没有内容时为 null。 */
  compact: (instructions: string | null) => void | Promise<void>;
  fork: () => void | Promise<void>;
}

/** 分发表：键 = 内建命令名单的全体（少一个类型检查不过）。 */
const LOCAL_SLASH_HANDLERS: Record<
  LocalSlashCommandName,
  (args: string, handlers: LocalSlashCommandHandlers) => void | Promise<void>
> = {
  name: (args, handlers) => handlers.rename(args || null),
  terminal: (_args, handlers) => handlers.openTerminal(),
  float: (_args, handlers) => handlers.float(),
  compact: (args, handlers) => handlers.compact(args || null),
  fork: (_args, handlers) => handlers.fork(),
};

/** 把「命令名 + 参数」分给对应的执行器；不是 hub 内建命令返回 false。 */
export async function dispatchLocalSlashCommand(
  name: string,
  args: string,
  handlers: LocalSlashCommandHandlers,
): Promise<boolean> {
  const handler = isLocalSlashCommandName(name)
    ? LOCAL_SLASH_HANDLERS[name as LocalSlashCommandName]
    : undefined;
  if (!handler) return false;
  await handler(args, handlers);
  return true;
}
