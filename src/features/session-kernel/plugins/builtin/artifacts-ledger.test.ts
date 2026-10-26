/** 修复20：产物路径台账——mv/Move-Item 解析、目录前缀改写、多跳、同名兜底。 */
import { describe, expect, it } from "vitest";
import { buildPathLedger, parseMoveCommand, resolveLedgerPath } from "./artifacts-ledger";
import type { PathLedger } from "./artifacts-ledger";

const use = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", name, input });

describe("parseMoveCommand", () => {
  it("parses mv / git mv / Move-Item with quotes (keeps original casing)", () => {
    expect(parseMoveCommand("mv A/B C")).toEqual([
      { from: "a/b", to: "c", fromDisplay: "A/B", toDisplay: "C" },
    ]);
    expect(parseMoveCommand('git mv "src/old name.ts" src/new.ts')).toEqual([
      { from: "src/old name.ts", to: "src/new.ts", fromDisplay: "src/old name.ts", toDisplay: "src/new.ts" },
    ]);
    expect(parseMoveCommand("Move-Item -Force a.ps1 ./scripts/a.ps1")).toMatchObject([
      { from: "a.ps1", to: "./scripts/a.ps1" },
    ]);
  });

  it("handles multi-source into dir", () => {
    expect(parseMoveCommand("mv a.txt b.txt docs").map((r) => [r.from, r.to])).toEqual([
      ["a.txt", "docs/a.txt"],
      ["b.txt", "docs/b.txt"],
    ]);
  });

  it("ignores non-move commands", () => {
    expect(parseMoveCommand("ls -la")).toEqual([]);
    expect(parseMoveCommand("echo mv x y")).toEqual([]);
  });

  it("recognizes mv inside && chains (user scenario: mkdir && mv && ls)", () => {
    const rules = parseMoveCommand(
      'mkdir -p "E:/JishuTest/小说" && mv "E:/JishuTest/声音的颜色.md" "E:/JishuTest/小说/声音的颜色.md" && ls -R "E:/JishuTest"',
    );
    expect(rules.map((r) => [r.from, r.to, r.toDisplay])).toEqual([
      ["e:/jishutest/声音的颜色.md", "e:/jishutest/小说/声音的颜色.md", "E:/JishuTest/小说/声音的颜色.md"],
    ]);
  });

  it("recognizes mv in semicolon / || separated segments", () => {
    expect(parseMoveCommand("cd /tmp; mv a b || echo failed").map((r) => [r.from, r.to])).toEqual([["a", "b"]]);
  });
});

describe("resolveLedgerPath", () => {
  const ledger: PathLedger = {
    moves: [{ from: "e:/proj/b", to: "e:/proj/c", fromDisplay: "E:/proj/B", toDisplay: "E:/proj/C" }],
    lastWrites: new Map([["foo.java", { path: "e:/proj/backend/foo.java", display: "E:/proj/backend/Foo.java" }]]),
  };

  it("rewrites stale paths under a moved directory, keeping original casing", () => {
    expect(resolveLedgerPath("E:\\proj\\B\\src\\Foo.java", ledger)).toBe("E:/proj/C/src/Foo.java");
  });

  it("follows chained moves (B→C then C→D)", () => {
    const chained: PathLedger = {
      moves: [
        { from: "e:/proj/b", to: "e:/proj/c", fromDisplay: "e:/proj/b", toDisplay: "e:/proj/c" },
        { from: "e:/proj/c", to: "e:/proj/d", fromDisplay: "e:/proj/c", toDisplay: "e:/proj/d" },
      ],
      lastWrites: new Map(),
    };
    expect(resolveLedgerPath("E:/proj/B/x.java", chained)).toBe("e:/proj/d/x.java");
  });

  it("falls back to same-name last write (display casing) when no move rule matches", () => {
    expect(resolveLedgerPath("E:/proj/src/Foo.java", ledger)).toBe("E:/proj/backend/Foo.java");
  });

  it("does NOT rewrite an already-resolved path back to the pre-move write location (user regression)", () => {
    // 用户场景：write 到旧位 → mv 旧位→新位；对**新位**再解析（显示层已
    // 换算后动作前二次解析）不得被 lastWrites 反向改写回旧位。
    const regressed: PathLedger = {
      moves: [
        { from: "e:/jishutest/声音的颜色.md", to: "e:/jishutest/小说/声音的颜色.md", fromDisplay: "E:/JishuTest/声音的颜色.md", toDisplay: "E:/JishuTest/小说/声音的颜色.md" },
      ],
      lastWrites: new Map([["声音的颜色.md", { path: "e:/jishutest/声音的颜色.md", display: "E:/JishuTest/声音的颜色.md" }]]),
    };
    expect(resolveLedgerPath("E:/JishuTest/小说/声音的颜色.md", regressed)).toBeNull();
    // 旧位解析仍应命中移动规则得到新位。
    expect(resolveLedgerPath("E:/JishuTest/声音的颜色.md", regressed)).toBe("E:/JishuTest/小说/声音的颜色.md");
  });

  it("returns null when nothing applies", () => {
    expect(resolveLedgerPath("E:/other/Bar.java", ledger)).toBeNull();
  });
});

describe("buildPathLedger", () => {
  it("collects moves from bash/powershell and last writes from write/edit", () => {
    const ledger = buildPathLedger([
      { blocks: [use("bash", { command: "mv B C" })] },
      { blocks: [use("write", { path: "C/app.java", content: "x" })] },
      { content: [{ type: "tool_use", name: "powershell", input: { command: "Move-Item x.yml C/x.yml" } }] },
    ]);
    expect(ledger.moves).toHaveLength(2);
    expect(ledger.lastWrites.get("app.java")).toEqual({ path: "c/app.java", display: "C/app.java" });
  });
});
