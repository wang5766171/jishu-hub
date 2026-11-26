/**
 * 选中态里的占位值——「有没有真实会话被打开」的单一判定（v0.9.8 评审修复轮 R2）。
 *
 * 「当前打开的是哪个会话」这个值有三类不是真实会话：空、新对话（"new"）、节点会话待定
 *（"pending-node"：任务工作台选中了节点，节点自己的会话还没建立）。未读清除、节点补读、
 * 离开位置记录、任务会话导流都靠这个判断；占位值本身也只在这里定义，别处不再写字面量。
 *
 * 放在内核层是因为未读判定点在内核（session-unread）：页面层的模块可以往下引用，
 * 内核不能反过来引用页面。任务占位是任务流程的概念，内核只当它是一个「不是会话」的值。
 */
export const NEW_SESSION_PLACEHOLDER = "new";
export const PENDING_NODE_PLACEHOLDER = "pending-node";

/** 没有真实会话被打开的选中态（空 / 新对话 / 节点会话待定）。
 *  同时是类型收窄：判断为假之后，调用方手里的就是一个非空的会话 id。 */
export function isNoSessionSelected(sessionId: string | null | undefined): sessionId is null | undefined {
  return !sessionId || sessionId === NEW_SESSION_PLACEHOLDER || sessionId === PENDING_NODE_PLACEHOLDER;
}
