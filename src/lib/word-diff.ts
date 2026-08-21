// v0.8.0 需求1 B2：内联词级 diff 的纯函数实现。
// 对相邻的 remove/add 行对做行内词级比对（对齐 TUI 行号+词级高亮的 GUI 等价物），
// 仅作渲染层增强，不改变 text-preview.ts 的行级数据模型（DiffRow）。

export interface DiffToken {
  text: string;
  changed: boolean;
}

/** 按空白切成 token（保留空白 token，拼接可还原整行）。 */
export function tokenizeLine(line: string): string[] {
  if (!line) return [];
  return line.split(/(\s+)/).filter((token) => token.length > 0);
}

/** 中段（前后缀收缩后）超过该 token 数时放弃 LCS，整体标记为变更（保守降级）。 */
export const MAX_MID_TOKENS = 32;

export interface WordDiffResult {
  oldTokens: DiffToken[];
  newTokens: DiffToken[];
}

function assemble(tokens: string[], prefix: number, suffix: number, midMarks: boolean[]): DiffToken[] {
  return tokens.map((text, index) => {
    const midIndex = index - prefix;
    const inMid = midIndex >= 0 && midIndex < midMarks.length;
    return { text, changed: inMid ? midMarks[midIndex] : false };
  });
}

/**
 * 词级比对一行旧文本与一行新文本。
 * 算法：token 化 → 公共前缀/后缀收缩（标 unchanged）→ 中段 LCS（≤32×32，
 * 超限整体标 changed）→ 回填 token 序列。
 * 返回 null 表示两行完全一致（无需词级渲染）。
 */
export function wordDiff(oldLine: string, newLine: string): WordDiffResult | null {
  const oldTokens = tokenizeLine(oldLine);
  const newTokens = tokenizeLine(newLine);

  let prefix = 0;
  while (
    prefix < oldTokens.length &&
    prefix < newTokens.length &&
    oldTokens[prefix] === newTokens[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix + prefix < oldTokens.length &&
    suffix + prefix < newTokens.length &&
    oldTokens[oldTokens.length - 1 - suffix] === newTokens[newTokens.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMid = oldTokens.slice(prefix, oldTokens.length - suffix);
  const newMid = newTokens.slice(prefix, newTokens.length - suffix);
  if (oldMid.length === 0 && newMid.length === 0) {
    return null;
  }

  if (oldMid.length > MAX_MID_TOKENS || newMid.length > MAX_MID_TOKENS) {
    return {
      oldTokens: assemble(oldTokens, prefix, suffix, oldMid.map(() => true)),
      newTokens: assemble(newTokens, prefix, suffix, newMid.map(() => true)),
    };
  }

  // dp[i][j] = oldMid[i..] 与 newMid[j..] 的 LCS 长度（≤33×33）。
  const n = oldMid.length;
  const m = newMid.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldMid[i] === newMid[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const oldMarks: boolean[] = new Array<boolean>(n).fill(true);
  const newMarks: boolean[] = new Array<boolean>(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldMid[i] === newMid[j]) {
      oldMarks[i] = false;
      newMarks[j] = false;
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return {
    oldTokens: assemble(oldTokens, prefix, suffix, oldMarks),
    newTokens: assemble(newTokens, prefix, suffix, newMarks),
  };
}
