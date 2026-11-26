// 斜杠命令原文的解析与还原（纯函数，无依赖）。
//
// 放在最底层是因为三处都要用：输入框（components/sessions/slash-command.ts 的查找与
// 分发都从这里的解析派生）、压缩请求（chat-core/use-compaction-request.ts 把补充要求
// 还原成 `/compact …`）、事件管线（session-kernel/kernel/event-pipeline.ts 认出待发送区
// 里排队的压缩条目）。页面层的模块可以往下引用，下层不能反过来引用组件目录。

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

/** `formatSlashCommand(name, args)` 的还原：排队条目里存的就是命令原文。 */
export function formatSlashCommand(name: string, args: string | null): string {
  return args ? `/${name} ${args}` : `/${name}`;
}

/**
 * 待发送区里排队的压缩条目（`kind: "compaction"`）→ 它的补充要求（没有
 * 补充要求为空串）。条目可以编辑，所以以**当前内容**为准：内容不再是
 * `/compact` 就不再是压缩条目，返回 null。
 */
export function stagedCompactionArgs(message: { kind?: string; content: string }): string | null {
  if (message.kind !== "compaction") return null;
  const parsed = parseSlashCommand(message.content);
  return parsed?.name === "compact" ? parsed.args : null;
}
