/** 界面错误文字的清洗——二轮评审 R3（域 4 P2-8 的前端部分）。 */
import { describe, expect, it } from "vitest";
import { userFacingError } from "./user-facing-error";

describe("userFacingError", () => {
  it("去掉开头的机器前缀与结尾括号里的英文原文，只留人话", () => {
    expect(userFacingError(new Error("会话连接已不在，请重新打开会话后再试"))).toBe("会话连接已不在，请重新打开会话后再试");
    expect(userFacingError(new Error("[no_active_session] 会话连接已不在，请重新打开会话后再试"))).toBe(
      "会话连接已不在，请重新打开会话后再试",
    );
    expect(userFacingError("[interaction_stale] 该交互已过期（回合已结束或会话重启），请重新触发提问")).toBe(
      "该交互已过期（回合已结束或会话重启），请重新触发提问",
    );
    // 修前会在界面上出现的两种形态：带前缀；结尾括号里是英文原文和会话号
    expect(userFacingError(new Error("[no_active_session] 会话连接已不在，请重新打开会话后再试（No active ACP session found for 01a2b3c4-5d6e）"))).toBe(
      "会话连接已不在，请重新打开会话后再试",
    );
    expect(userFacingError("提交超时（10 秒无响应），请重试")).toBe("提交超时（10 秒无响应），请重试");
  });

  it("不是 Error 的值也能洗；洗完什么都没有时原样返回，不给出一个空的报错", () => {
    expect(userFacingError("[interaction_stale]")).toBe("[interaction_stale]");
    expect(userFacingError(null)).toBe("null");
  });
});
