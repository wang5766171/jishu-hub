// v0.9.8 需求2 D2-1：编辑重发失败回滚纯函数行为锚定（F1 核心止血路径的
// 回归锁——修前零测试覆盖）+ D2-3 cut<0 收敛（不再全量复活已删旧消息）。
import { describe, expect, it } from "vitest";

import type { Message } from "@/types";
import { applyEditResendRollback } from "./chat-page-utils";

function userMsg(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text, tool_ids: [] }],
    timestamp: 1,
  };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 2 };
}

describe("applyEditResendRollback（需求2 D2-1/D2-3）", () => {
  it("U2-1 正常回滚：恢复到截断点前缀（乐观追加的编辑消息移除）+ 回填外发文本", () => {
    const msgs = [userMsg("第一问"), assistantMsg("回答一"), userMsg("被编辑的原文")];
    const r = applyEditResendRollback(msgs, 2, "编辑后的新文本");
    expect(r.reload).toBe(false);
    expect(r.messages).toHaveLength(2);
    expect(r.messages?.[1]).toEqual(assistantMsg("回答一"));
    expect(r.restoreText).toBe("编辑后的新文本");
  });

  it("U2-1b 截断点为 0：恢复为空列表（首条即被编辑消息）", () => {
    const msgs = [userMsg("唯一被编辑的消息")];
    const r = applyEditResendRollback(msgs, 0, "改写");
    expect(r.reload).toBe(false);
    expect(r.messages).toEqual([]);
    expect(r.restoreText).toBe("改写");
  });

  it("U2-2 cut<0 收敛：不恢复列表（返回 reload 信号）——不再全量复活已删旧消息", () => {
    const msgs = [userMsg("旧消息A"), assistantMsg("旧回复"), userMsg("已不存在的原文")];
    const r = applyEditResendRollback(msgs, -1, "重发文本");
    expect(r.reload).toBe(true);
    expect(r.messages).toBeUndefined();
    expect(r.restoreText).toBe("重发文本");
  });

  it("U2-3 回填文本含任务前缀包装（外发态原样回填，不二次加工）", () => {
    const outgoing = "/jishu-task dev 编辑后的内容";
    const r = applyEditResendRollback([userMsg("x")], 0, outgoing);
    expect(r.restoreText).toBe(outgoing);
  });
});
