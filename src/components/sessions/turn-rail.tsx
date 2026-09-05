import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ContentBlock, Message } from "@/types";

/** v0.9.1 需求5：一轮对话的悬停预览摘要。question 取该轮用户消息全部
 * text 块拼接；answer 取该轮首个非空 assistant text 块（“前几句回答”），
 * 纯工具调用轮为空串，预览显示（无文本）兜底。 */
export interface TurnSummary {
  question: string;
  answer: string;
}

/** 轮次划分与 message-view.tsx buildRenderRows 的行语义逐条对齐：
 * assistant 消息归入当前轮；非 assistant 消息开启新轮（user 行），
 * 唯一例外是“纯 tool_result 的用户消息且其前存在 assistant 组”——被吞并
 * 进 assistant 组不占行，也不占轮次。保证第 N 条横杠 ↔ 第 N 个
 * [data-turn-index] DOM 行严格一一对应。 */
export function buildTurnSummaries(messages: Message[]): TurnSummary[] {
  const turns: TurnSummary[] = [];
  let current: TurnSummary | null = null;
  let inAssistantGroup = false;

  const textOf = (msg: Message): string =>
    msg.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

  messages.forEach((msg) => {
    if (msg.role === "assistant") {
      inAssistantGroup = true;
      if (current && !current.answer) {
        const text = textOf(msg);
        if (text) current.answer = text;
      }
      return;
    }
    const toolResultOnly =
      msg.role === "user" &&
      msg.content.length > 0 &&
      msg.content.every((block) => block.type === "tool_result");
    if (toolResultOnly && inAssistantGroup) return;
    if (current) turns.push(current);
    current = { question: textOf(msg), answer: "" };
    inAssistantGroup = false;
  });
  if (current) turns.push(current);
  return turns;
}

interface TurnRailProps {
  turns: TurnSummary[];
  /** 当前阅读位置所在轮（scroll-spy），-1 = 未知。 */
  activeIndex: number;
  onJump: (index: number) => void;
}

/** v0.9.1 需求5：第二栏最左缘的“横杠导航轨”（参考 zcode）——每轮用户对话
 * 一条横杠；悬停浮出预览卡片（问题两行 / 回答三行截断）；点击平滑滚动
 * 到对应轮次。
 *
 * 定位细节：轨道外层容器 pointer-events-none（空白处穿透不挡消息区），
 * 仅横杠按钮自身可交互；轮次过多时轨道内部滚动且隐藏滚动条。预览卡片
 * 挂在外层轨道（而非内部滚动层——overflow 会把 absolute 子元素裁剪
 * 掉），hover 时测量横杠相对轨道的偏移定位，垂直居中于横杠。 */
export function TurnRail({ turns, activeIndex, onJump }: TurnRailProps) {
  const { t } = useTranslation();
  const railRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<{ index: number; top: number } | null>(null);

  if (turns.length === 0) return null;

  const showPreview = (index: number, bar: HTMLElement) => {
    const rail = railRef.current;
    if (!rail) return;
    const top = bar.getBoundingClientRect().top - rail.getBoundingClientRect().top;
    setHovered({ index, top });
  };
  const hidePreview = (index: number) => {
    setHovered((cur) => (cur?.index === index ? null : cur));
  };

  return (
    <div
      ref={railRef}
      role="navigation"
      aria-label={t("sessions.turnRail.label")}
      className="pointer-events-none absolute inset-y-0 left-0 z-10 flex w-6 justify-center"
    >
      <div className="flex max-h-full flex-col items-center gap-2.5 overflow-y-auto py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {turns.map((_turn, index) => (
          <button
            key={index}
            type="button"
            data-turn-rail-item={index}
            aria-label={t("sessions.turnRail.jump", { index: index + 1 })}
            className="group pointer-events-auto relative flex h-2 w-4 shrink-0 cursor-pointer items-center justify-center"
            onMouseEnter={(e) => showPreview(index, e.currentTarget)}
            onMouseLeave={() => hidePreview(index)}
            onFocus={(e) => showPreview(index, e.currentTarget)}
            onBlur={() => hidePreview(index)}
            onClick={() => onJump(index)}
          >
            <span
              className={cn(
                "h-0.5 rounded-full transition-all",
                index === activeIndex
                  ? "w-5 bg-foreground/80"
                  : "w-4 bg-border group-hover:bg-muted-foreground/60",
              )}
            />
          </button>
        ))}
      </div>
      {hovered && (
        <div
          className="pointer-events-none absolute left-6 z-20 w-72 max-w-[calc(100vw-5rem)] -translate-y-1/2 rounded-lg border border-border/60 bg-popover/95 px-3 py-2.5 text-left shadow-lg backdrop-blur"
          style={{ top: hovered.top + 4 }}
        >
          <div className="text-[10px] font-medium text-muted-foreground/70">
            {t("sessions.turnRail.question")}
          </div>
          <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[13px] font-medium leading-snug text-foreground">
            {turns[hovered.index]?.question || t("sessions.turnRail.empty")}
          </div>
          <div className="mt-2 text-[10px] font-medium text-muted-foreground/70">
            {t("sessions.turnRail.answer")}
          </div>
          <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-snug text-muted-foreground">
            {turns[hovered.index]?.answer || t("sessions.turnRail.empty")}
          </div>
        </div>
      )}
    </div>
  );
}
