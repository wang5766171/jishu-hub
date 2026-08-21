import { describe, expect, it } from "vitest";
import { MAX_MID_TOKENS, tokenizeLine, wordDiff, type DiffToken } from "./word-diff";

function text(tokens: DiffToken[]): string {
  return tokens.map((token) => token.text).join("");
}

function changedSpans(tokens: DiffToken[]): string {
  return tokens
    .filter((token) => token.changed)
    .map((token) => token.text.trim())
    .filter((t) => t.length > 0)
    .join("|");
}

describe("tokenizeLine", () => {
  it("splits on whitespace and keeps separator tokens", () => {
    expect(tokenizeLine("a  b\tc")).toEqual(["a", "  ", "b", "\t", "c"]);
  });

  it("returns empty for empty lines", () => {
    expect(tokenizeLine("")).toEqual([]);
  });

  it("keeps a full-width/CJK line as a single token (degenerate, whole-line change)", () => {
    expect(tokenizeLine("你好世界")).toEqual(["你好世界"]);
  });
});

describe("wordDiff", () => {
  it("returns null for identical lines", () => {
    expect(wordDiff("const a = 1;", "const a = 1;")).toBeNull();
  });

  it("marks only the changed word in a simple edit", () => {
    const result = wordDiff("const count = 0;", "const total = 0;");
    expect(result).not.toBeNull();
    expect(changedSpans(result!.oldTokens)).toBe("count");
    expect(changedSpans(result!.newTokens)).toBe("total");
  });

  it("marks nothing changed for whitespace-only differences inside a common token boundary", () => {
    // 前后缀收缩后中段只有空白差异：非空白 token 全部是公共前后缀。
    const result = wordDiff("a b", "a  b");
    expect(result).not.toBeNull();
    expect(changedSpans(result!.newTokens)).toBe("");
  });

  it("marks a pure addition on the new side only", () => {
    const result = wordDiff("use foo;", "use foo::bar;");
    expect(changedSpans(result!.oldTokens)).toBe("foo;");
    expect(changedSpans(result!.newTokens)).toBe("foo::bar;");
  });

  it("marks a pure removal on the old side only", () => {
    const result = wordDiff("let mut x = 1;", "let x = 1;");
    expect(changedSpans(result!.oldTokens)).toBe("mut");
    expect(changedSpans(result!.newTokens)).toBe("");
  });

  it("finds common subsequence inside the mid section via LCS", () => {
    const result = wordDiff("foo alpha beta gamma", "foo delta beta epsilon");
    // 前缀 "foo" 与中段公共词 "beta" 均不变。
    expect(changedSpans(result!.oldTokens)).toBe("alpha|gamma");
    expect(changedSpans(result!.newTokens)).toBe("delta|epsilon");
  });

  it("degrades to all-changed when the mid section exceeds the token budget", () => {
    // 逐 token 全异（含空白 token 相等但首尾非空白即异）：前后缀收缩为 0，
    // 中段 token 数超预算 → 整体标 changed，不跑 LCS。
    const repeated = (token: string) =>
      Array.from({ length: MAX_MID_TOKENS + 1 }, () => token).join(" ");
    const result = wordDiff(repeated("x"), repeated("y"))!;
    expect(result.oldTokens.filter((t) => t.text.trim()).every((t) => t.changed)).toBe(true);
    expect(result.newTokens.filter((t) => t.text.trim()).every((t) => t.changed)).toBe(true);
    expect(changedSpans(result.oldTokens)).toBe(
      Array.from({ length: MAX_MID_TOKENS + 1 }, () => "x").join("|"),
    );
  });

  it("handles empty old line (whole new line added)", () => {
    const result = wordDiff("", "hello world");
    expect(changedSpans(result!.oldTokens)).toBe("");
    expect(changedSpans(result!.newTokens)).toBe("hello|world");
  });

  it("handles empty new line (whole old line removed)", () => {
    const result = wordDiff("hello world", "");
    expect(changedSpans(result!.oldTokens)).toBe("hello|world");
    expect(changedSpans(result!.newTokens)).toBe("");
  });

  it("round-trips: token concatenation reproduces the source lines", () => {
    const oldLine = "fn main() { let x = compute(1, 2); }";
    const newLine = "fn main() { let x = compute(1, 2, 3); }";
    const result = wordDiff(oldLine, newLine)!;
    expect(text(result.oldTokens)).toBe(oldLine);
    expect(text(result.newTokens)).toBe(newLine);
  });

  it("treats a CJK line without spaces as one token (whole-line change)", () => {
    const result = wordDiff("你好世界", "你好伙伴");
    expect(changedSpans(result!.oldTokens)).toBe("你好世界");
    expect(changedSpans(result!.newTokens)).toBe("你好伙伴");
  });
});
