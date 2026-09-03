import { describe, expect, it } from "vitest";
import { resolveViewerPath } from "./path-resolve";

describe("resolveViewerPath", () => {
  it("绝对路径原样透传（盘符 / UNC / POSIX 根）", () => {
    expect(resolveViewerPath("D:\\a\\b.txt", "/any/project")).toBe("D:\\a\\b.txt");
    expect(resolveViewerPath("\\\\srv\\share\\f.rs", "/any/project")).toBe("\\\\srv\\share\\f.rs");
    expect(resolveViewerPath("/usr/src/a.ts", "/any/project")).toBe("/usr/src/a.ts");
    expect(resolveViewerPath("C:/x/y.md", "/any/project")).toBe("C:/x/y.md");
  });

  it("相对路径以项目根解析（正反斜杠统一为 /）", () => {
    expect(resolveViewerPath("src/lib/a.ts", "D:\\proj")).toBe("D:/proj/src/lib/a.ts");
    expect(resolveViewerPath("src\\lib\\a.ts", "D:/proj")).toBe("D:/proj/src/lib/a.ts");
  });

  it("项目根尾部斜杠不产生重复分隔符", () => {
    expect(resolveViewerPath("src/a.ts", "D:\\proj\\")).toBe("D:/proj/src/a.ts");
    expect(resolveViewerPath("a.ts", "/home/u/p/")).toBe("/home/u/p/a.ts");
  });

  it("无项目根或空路径时保持原样", () => {
    expect(resolveViewerPath("src/a.ts", null)).toBe("src/a.ts");
    expect(resolveViewerPath("src/a.ts", undefined)).toBe("src/a.ts");
    expect(resolveViewerPath("", "D:/proj")).toBe("");
  });
});
