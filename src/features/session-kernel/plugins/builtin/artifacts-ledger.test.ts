/** 修复20：产物路径台账——mv/Move-Item 解析、目录前缀改写、多跳、同名兜底。 */
import { describe, expect, it } from "vitest";
import { buildPathLedger, parseMoveCommand, resolveLedgerPath } from "./artifacts-ledger";
import type { PathLedger } from "./artifacts-ledger";

const use = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", name, input });

describe("parseMoveCommand", () => {
  it("parses mv / git mv / Move-Item with quotes", () => {
    expect(parseMoveCommand("mv A/B C")).toEqual([{ from: "a/b", to: "c" }]);
    expect(parseMoveCommand('git mv "src/old name.ts" src/new.ts')).toEqual([{ from: "src/old name.ts", to: "src/new.ts" }]);
    expect(parseMoveCommand("Move-Item -Force a.ps1 ./scripts/a.ps1")).toEqual([{ from: "a.ps1", to: "./scripts/a.ps1" }]);
  });

  it("handles multi-source into dir", () => {
    expect(parseMoveCommand("mv a.txt b.txt docs")).toEqual([
      { from: "a.txt", to: "docs/a.txt" },
      { from: "b.txt", to: "docs/b.txt" },
    ]);
  });

  it("ignores non-move commands", () => {
    expect(parseMoveCommand("ls -la")).toEqual([]);
    expect(parseMoveCommand("echo mv x y")).toEqual([]);
  });
});

describe("resolveLedgerPath", () => {
  const ledger: PathLedger = {
    moves: [{ from: "e:/proj/b", to: "e:/proj/c" }],
    lastWrites: new Map([["foo.java", "e:/proj/backend/foo.java"]]),
  };

  it("rewrites stale paths under a moved directory (prefix rule)", () => {
    expect(resolveLedgerPath("E:\\proj\\B\\src\\Foo.java", ledger)).toBe("e:/proj/c/src/foo.java");
  });

  it("follows chained moves (B→C then C→D)", () => {
    const chained: PathLedger = {
      moves: [
        { from: "e:/proj/b", to: "e:/proj/c" },
        { from: "e:/proj/c", to: "e:/proj/d" },
      ],
      lastWrites: new Map(),
    };
    expect(resolveLedgerPath("E:/proj/B/x.java", chained)).toBe("e:/proj/d/x.java");
  });

  it("falls back to same-name last write when no move rule matches", () => {
    expect(resolveLedgerPath("E:/proj/src/Foo.java", ledger)).toBe("e:/proj/backend/foo.java");
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
    expect(ledger.lastWrites.get("app.java")).toBe("c/app.java");
  });
});
