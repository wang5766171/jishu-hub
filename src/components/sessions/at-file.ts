/**
 * @ 文件引用触发检测（v0.9.0 需求10，用户裁决简化版）。
 *
 * 最简逻辑：光标前出现 @ 即触发全文件搜索；用户继续输入即过滤，能匹配
 * 上由用户选（选中=引入文件），不选/无匹配即为普通 @ 文本（需求9：无
 * 匹配不弹层）。不做任何前置字符拦截（邮箱/@@ 形态同样触发，无妨——
 * 匹配不上就不弹）。token 内出现空白即结束（@ 引用终止，回到普通文本）。
 */

export function detectAtToken(beforeCaret: string): string | null {
  const atIdx = beforeCaret.lastIndexOf("@");
  if (atIdx < 0) return null;
  const token = beforeCaret.slice(atIdx + 1);
  if (/\s/.test(token)) return null;
  return token;
}
