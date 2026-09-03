import { describe, expect, it } from "vitest";
import { parseEmbeddedTools } from "./embedded-tools";

describe("parseEmbeddedTools（M7：标记解析契约锁定）", () => {
  it("剥离单个标记并提取 id 列表", () => {
    const r = parseEmbeddedTools("[JISHU-TOOLS:a,b] 你好");
    expect(r.text).toBe("你好");
    expect(r.toolIds).toEqual(["a", "b"]);
  });

  it("无标记时原样返回且无 id", () => {
    const r = parseEmbeddedTools("普通消息");
    expect(r.text).toBe("普通消息");
    expect(r.toolIds).toEqual([]);
  });

  it("只剥行首标记（正文中的标记串不误伤）", () => {
    const r = parseEmbeddedTools("讨论 [JISHU-TOOLS:x] 这个格式");
    expect(r.text).toBe("讨论 [JISHU-TOOLS:x] 这个格式");
    expect(r.toolIds).toEqual([]);
  });

  it("id 逗号分隔回收敛（空段过滤）", () => {
    const r = parseEmbeddedTools("[JISHU-TOOLS:a, ,b] hi");
    expect(r.toolIds).toEqual(["a", "b"]);
  });

  it("标记后紧跟换行也剥净", () => {
    const r = parseEmbeddedTools("[JISHU-TOOLS:a]\n问题正文");
    expect(r.text).toBe("问题正文");
  });
});
