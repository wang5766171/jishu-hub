/**
 * 工具 token `@[显示名]`——输入框里工具 pill 的文本形态，也是消息里工具标签的
 * 原始文本（v0.9.8 评审修复轮 R2，用户裁决「标签不是 @[] 进行输送的吗，这种在
 * 搜索时识别原始文本即可」）。
 *
 * 消息气泡里每个标签在页面上的文字就是它的原始文本：显示名看得见，首尾的
 * `@[` `]` 不占宽度。搜索按原始文本识别标签——搜显示名、搜 `@[名]` 都命中同一个
 * 标签，搜索文本与页面文字因此是同一份。
 *
 * token 的写法只在这里定义一处：气泡渲染（embedded-tools.tsx）与搜索文本
 * （session-search-text.ts）都从这里取。
 */

/** `@[显示名]` 的原始文本。 */
export function toolTokenText(name: string): string {
  return `@[${name}]`;
}

/** 正文里的一处工具 token：`index` 是它在正文里的起始位置，`name` 是方括号里的字。 */
export type ToolToken = { index: number; name: string };

/** 正文里的工具 token，按出现先后。 */
export function findToolTokens(text: string): ToolToken[] {
  if (!text || !text.includes("@[")) return [];
  const tokens: ToolToken[] = [];
  for (const match of text.matchAll(/@\[([^\]]+)\]/g)) {
    tokens.push({ index: match.index, name: match[1] });
  }
  return tokens;
}

/**
 * 跟在正文后面的标签：消息的工具集里，没有被正文内联字样覆盖到的 id。
 * 渲染（UserTextWithPills 的尾随组）与搜索文本用同一个判定——页面上跟着正文
 * 之后出现的标签，就是搜索文本末尾追加的那几个。
 */
export function trailingToolIds(
  text: string,
  toolIds: readonly string[],
  toolNames: Readonly<Record<string, string>>,
): string[] {
  if (toolIds.length === 0) return [];
  const knownNames = new Set(Object.values(toolNames));
  const inlinedNames = new Set<string>();
  for (const { name } of findToolTokens(text)) {
    if (knownNames.has(name)) inlinedNames.add(name);
  }
  return toolIds.filter((id) => !inlinedNames.has(toolNames[id] ?? ""));
}
