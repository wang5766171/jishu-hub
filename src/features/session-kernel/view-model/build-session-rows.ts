import type { ContentBlock, Message } from "@/types";

/**
 * 会话内核统一视图模型（v0.9.2 需求1 P1）——「行/轮次」语义的单一权威。
 *
 * 此前 `buildRenderRows`（message-view.tsx）与 `buildTurnSummaries`
 * （turn-rail.tsx）各自实现同一套行语义并靠注释声明契约对齐，任何需要轮次
 * 视图的新能力（插件）都只能再抄一份。本模块吸收两处实现的公共语义：
 *
 * - assistant 消息连续归并为一个 assistant 组行；
 * - 「纯 tool_result 的 user 消息且其前存在 assistant 组」被吞并进该组
 *   （不占行、不占轮次）；
 * - 其余消息各占一个 user 行，并按出现顺序获得轮次序号（第 N 个 user 行
 *   = 第 N 轮，与 [data-turn-index] DOM 属性一一对应）。
 */

/** 一行渲染模型。 */
export interface SessionRowModel {
  kind: "user" | "assistant";
  /** user 行：该消息在 messages 中的下标。 */
  messageIndex: number;
  /** assistant 组：首条消息下标（与 messageIndex 同值，便于统一读取）。 */
  startIndex: number;
  /** assistant 组：末条消息下标。 */
  endIndex: number;
  /** assistant 组：组内全部消息下标（含被吞并的纯 tool_result user 消息）。 */
  messageIndices: number[];
  /** user 行的轮次序号（实例内从 0 递增）；assistant 行为 undefined。 */
  turnIndex?: number;
}

/** 一轮对话的悬停预览摘要（导航轨等轮次视图消费）。 */
export interface TurnSummary {
  question: string;
  answer: string;
}

function isUserToolResultOnlyMessage(msg: Message): boolean {
  if (msg.role !== "user" || msg.content.length === 0) return false;
  return msg.content.every((block) => block.type === "tool_result");
}

/** 行划分：见模块注释。 */
export function buildSessionRows(messages: Message[]): SessionRowModel[] {
  const rows: SessionRowModel[] = [];
  let assistantGroup: SessionRowModel | null = null;
  let turnCounter = 0;

  const flushAssistant = () => {
    if (!assistantGroup) return;
    rows.push(assistantGroup);
    assistantGroup = null;
  };

  messages.forEach((msg, i) => {
    if (msg.role === "assistant") {
      if (!assistantGroup) {
        assistantGroup = {
          kind: "assistant",
          messageIndex: i,
          startIndex: i,
          endIndex: i,
          messageIndices: [i],
        };
      } else {
        assistantGroup.endIndex = i;
        assistantGroup.messageIndices.push(i);
      }
      return;
    }

    if (isUserToolResultOnlyMessage(msg) && assistantGroup) {
      assistantGroup.endIndex = i;
      assistantGroup.messageIndices.push(i);
      return;
    }

    flushAssistant();
    rows.push({
      kind: "user",
      messageIndex: i,
      startIndex: i,
      endIndex: i,
      messageIndices: [i],
      turnIndex: turnCounter++,
    });
  });

  flushAssistant();
  return rows;
}

function textOf(msg: Message): string {
  return msg.content
    .filter(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * 轮次摘要：question 取该轮 user 消息全部 text 块拼接；answer 取该轮之后
 * 首个 assistant 组里第一个非空 text 块（纯工具轮为空串，预览显示兜底文案）。
 * 会话开头（首条 user 之前）的 assistant 组不计入任何轮次。
 */
export function buildTurnSummaries(
  messages: Message[],
  rows?: SessionRowModel[],
): TurnSummary[] {
  const sessionRows = rows ?? buildSessionRows(messages);
  const turns: TurnSummary[] = [];
  let current: TurnSummary | null = null;

  sessionRows.forEach((row) => {
    if (row.kind === "assistant") {
      if (current && !current.answer) {
        for (const index of row.messageIndices) {
          const text = textOf(messages[index]);
          if (text) {
            current.answer = text;
            break;
          }
        }
      }
      return;
    }
    if (current) turns.push(current);
    current = { question: textOf(messages[row.messageIndex]), answer: "" };
  });
  if (current) turns.push(current);
  return turns;
}
