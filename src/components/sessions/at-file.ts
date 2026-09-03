/**
 * @ 文件引用触发检测（v0.9.0 需求10：行中触发）。
 *
 * 规则：取光标前最近的 @；其前一个字符为行首、空白、CJK、标点等
 * **非 ASCII 词字符**时触发（中文书写不打空格，行中间 @ 必须可用）；
 * ASCII 字母/数字/下划线或另一个 @ 在前则不触发（邮箱 user@host 与
 * a@b 形态路径的误触保护）。@ 到光标之间出现空白即视为 token 结束。
 */

/** ASCII 词字符（字母/数字/下划线）——@ 前出现则视为标识符/邮箱的一部分。 */
const ASCII_WORD = /[A-Za-z0-9_]/;

export function detectAtToken(beforeCaret: string): string | null {
  const atIdx = beforeCaret.lastIndexOf("@");
  if (atIdx < 0) return null;
  const prev = atIdx > 0 ? beforeCaret[atIdx - 1] : null;
  if (prev !== null && (ASCII_WORD.test(prev) || prev === "@")) return null;
  const token = beforeCaret.slice(atIdx + 1);
  if (/\s/.test(token)) return null;
  return token;
}
