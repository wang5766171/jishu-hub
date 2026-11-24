/**
 * 斜杠命令文本规则单点（v0.9.8 需求7 补充轮）。
 *
 * 命令面板里的命令**一律选中只填入输入框**，点发送才决定去向：
 * - hub 内建命令（`local`）由 hub 在本地执行——pi 的 prompt 通道只执行扩展
 *   命令，不执行内建命令；
 * - 其余（pi 动态命令、普通消息）照常发给智能体。
 */

export interface SlashCommandInfo {
  name: string;
  label: string;
  available: boolean;
  /** true = hub 内建命令，发送时本地执行；缺省 = 发送给智能体。 */
  local?: boolean;
}

export interface ParsedSlashCommand {
  name: string;
  /** 命令名之后的全部文本（已去掉首尾空白）；没有参数为空串。 */
  args: string;
}

/** `/名字 参数…` → { name, args }；不是这个形状 → null。 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1], args: (match[2] ?? "").trim() };
}

/** 文本是清单里的 hub 内建命令时返回解析结果；否则 null（照常发给智能体）。 */
export function findLocalSlashCommand(
  text: string,
  commands: readonly SlashCommandInfo[] | undefined,
): ParsedSlashCommand | null {
  const parsed = parseSlashCommand(text);
  if (!parsed || !commands) return null;
  return commands.some((command) => command.name === parsed.name && command.local)
    ? parsed
    : null;
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

/** 把「命令名 + 参数」分给对应的执行器；不是 hub 内建命令返回 false。 */
export async function dispatchLocalSlashCommand(
  name: string,
  args: string,
  handlers: LocalSlashCommandHandlers,
): Promise<boolean> {
  switch (name) {
    case "name":
      await handlers.rename(args || null);
      return true;
    case "terminal":
      await handlers.openTerminal();
      return true;
    case "float":
      await handlers.float();
      return true;
    case "compact":
      await handlers.compact(args || null);
      return true;
    case "fork":
      await handlers.fork();
      return true;
    default:
      return false;
  }
}
