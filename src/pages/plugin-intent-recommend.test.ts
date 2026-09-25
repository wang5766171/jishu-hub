import { describe, expect, it } from "vitest";
import { recommendIntent, intentLabel, INTENT_CARDS } from "./plugin-intent-recommend";

/** 3a-4（v0.9.5 需求1）：描述功能 → 类型推荐（验收 3a-4 样本对齐 4a 的 S 系列）。 */
describe("3a-4：recommendIntent 描述推荐", () => {
  it("数据面板样本（S2 会话里显示工具调用统计）", () => {
    const r = recommendIntent("在会话里显示工具调用统计");
    expect(r?.intent).toBe("data-panel");
    expect(r?.preset).toMatchObject({ sourceType: "messages", mount: "dock-panel" });
  });

  it("通知样本（S10 会话完成后弹桌面通知）", () => {
    const r = recommendIntent("会话完成后弹桌面通知");
    expect(r?.intent).toBe("notify");
    expect(r?.preset).toMatchObject({ sourceType: "signal", mount: "event-hook", notifyAction: true });
  });

  it("渲染样本（mermaid 代码块）", () => {
    const r = recommendIntent("把 mermaid 代码块渲染得更好看");
    expect(r?.intent).toBe("content-render");
    expect(r?.preset).toMatchObject({ sourceType: "code-block", mount: "block-renderer" });
  });

  it("导航样本", () => {
    const r = recommendIntent("做一个轮次大纲快速跳转");
    expect(r?.intent).toBe("navigation");
  });

  it("流水线样本（S4 视频制作流程）", () => {
    const r = recommendIntent("帮我编排一个视频制作流程：需求→分镜→素材→成片");
    expect(r?.intent).toBe("pipeline");
    expect(r?.preset).toBeNull();
  });

  it("智能体工具样本（S1 让 AI 能生成二维码）", () => {
    const r = recommendIntent("帮我加一个工具，让 AI 能生成二维码");
    expect(r?.intent).toBe("agent-tool");
  });

  it("花销样本（S3 每轮结束显示花销——数据面板向）", () => {
    const r = recommendIntent("每轮结束显示花了多少钱");
    expect(r?.intent).toBe("data-panel");
  });

  it("零命中返回 null（追问用户细节）", () => {
    expect(recommendIntent("你好世界")).toBeNull();
    expect(recommendIntent("")).toBeNull();
    expect(recommendIntent("   ")).toBeNull();
  });

  it("推荐理由含命中关键词（置信依据）", () => {
    const r = recommendIntent("桌面通知");
    expect(r?.reason).toContain("命中");
    expect(r?.reason).toContain("通知");
  });

  it("四定位卡完整（组合向导 intent 步数据源）", () => {
    expect(INTENT_CARDS.map((c) => c.intent)).toEqual([
      "data-panel",
      "notify",
      "content-render",
      "navigation",
    ]);
    expect(INTENT_CARDS.every((c) => intentLabel(c.intent) === c.title)).toBe(true);
  });
});
