/**
 * 需求8 单测：默认智能体排序——jishu-self 置顶（用户裁决：第一次默认
 * jishu agent 的根本逻辑 = 排在最前面，所有「首个可用」兜底与切换器
 * 展示序随之命中；其余保持后端返回序，稳定排序）。
 */
import { describe, expect, it } from "vitest";
import { defaultAgentId, sortAgentsJishuFirst } from "./AgentContext";

const agent = (id: string) => ({ id });

describe("sortAgentsJishuFirst", () => {
  it("moves jishu-self to front regardless of original position", () => {
    expect(
      sortAgentsJishuFirst([agent("claude-code"), agent("jishu-self"), agent("codex")]).map((a) => a.id),
    ).toEqual(["jishu-self", "claude-code", "codex"]);
  });

  it("keeps order when jishu-self already first", () => {
    expect(
      sortAgentsJishuFirst([agent("jishu-self"), agent("codex")]).map((a) => a.id),
    ).toEqual(["jishu-self", "codex"]);
  });

  it("no jishu-self → order unchanged", () => {
    expect(
      sortAgentsJishuFirst([agent("codex"), agent("claude-code")]).map((a) => a.id),
    ).toEqual(["codex", "claude-code"]);
  });

  it("does not mutate the input array", () => {
    const input = [agent("codex"), agent("jishu-self")];
    const sorted = sortAgentsJishuFirst(input);
    expect(input.map((a) => a.id)).toEqual(["codex", "jishu-self"]);
    expect(sorted).not.toBe(input);
  });
});

describe("defaultAgentId（需求21：无记录时默认恒 jishu-self）", () => {
  it("picks jishu-self even when another installed agent sorts first in backend order", () => {
    const list = [
      { id: "claude-code", health: { installed: false } },
      { id: "opencode", health: { installed: true } },
      { id: "jishu-self", health: { installed: true } },
    ];
    // 旧实现的缺陷形态：后端序首个已安装 = opencode——现必须 jishu-self。
    expect(defaultAgentId(list)).toBe("jishu-self");
  });

  it("falls back to first installed only when jishu-self is absent", () => {
    expect(
      defaultAgentId([
        { id: "claude-code", health: { installed: false } },
        { id: "codex", health: { installed: true } },
      ]),
    ).toBe("codex");
  });

  it("falls back to first entry when none installed", () => {
    expect(defaultAgentId([{ id: "a", health: { installed: false } }])).toBe("a");
    expect(defaultAgentId([])).toBe("");
  });
});
