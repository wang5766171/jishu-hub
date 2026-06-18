/**
 * InteractionCard — a collapsible card that displays a persisted Q&A pair
 * (question prompt + options + user answer). Used in both committed messages
 * (conversation-content.tsx) and streaming previews (streaming-message.tsx).
 *
 * - Default: collapsed, showing summary (prompt + answer preview).
 * - Pending (streaming): expanded with the option form visible.
 * - Click header to toggle.
 */
import { memo, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, MessageCircleQuestion } from "lucide-react";
import { cn } from "@/lib/utils";

export interface InteractionCardOption {
  option_id: string;
  label: string;
  description?: string | null;
}



/**
 * Renders a single persisted interaction as a collapsible card.
 * Always starts collapsed for committed messages; the streaming path
 * can force it open via the `defaultOpen` prop if needed.
 */export interface InteractionCardItem {
  prompt: string;
  options?: InteractionCardOption[];
  answer: string;
  selectedOptions?: string[];
}

export interface InteractionCardProps {
  items?: InteractionCardItem[];
  prompt?: string;
  options?: InteractionCardOption[];
  answer?: string;
  selectedOptions?: string[];
  origin?: string;
}

const ORIGIN_LABELS: Record<string, string> = {
  extension_ui: "Jishu Agent",
  acp_elicitation: "Claude Code",
  codex_tool_request_user_input: "Codex",
};

/**
 * Renders one or more persisted interactions as a collapsible card.
 * Always starts collapsed for committed messages; the streaming path
 * can force it open via the `defaultOpen` prop if needed.
 */
export const InteractionCard = memo(function InteractionCard({
  items,
  prompt,
  options,
  answer,
  selectedOptions,
  origin,
  defaultOpen = false,
}: InteractionCardProps & { defaultOpen?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);

  const originLabel = origin
    ? ORIGIN_LABELS[origin] ?? t("sessions.interactionDefault", { defaultValue: "向用户提问" })
    : t("sessions.interactionDefault", { defaultValue: "向用户提问" });

  const itemsToRender: InteractionCardItem[] = useMemo(() => {
    if (items && items.length > 0) {
      return items;
    }
    return [
      {
        prompt: prompt ?? "",
        options,
        answer: answer ?? "",
        selectedOptions,
      },
    ];
  }, [items, prompt, options, answer, selectedOptions]);

  return (
    <div
      className={cn(
        "my-2 rounded-[6px] border transition-colors",
        open
          ? "border-primary/30 bg-primary/[0.03]"
          : "border-border/50 bg-muted/20 hover:border-border/70",
      )}
    >
      {/* Header — always visible, click to toggle */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left select-none"
      >
        <MessageCircleQuestion className="h-4 w-4 shrink-0 text-primary/70" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {t("sessions.interactionDefault", { defaultValue: "向用户提问" })}
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {/* Expanded content */}
      {open && (
        <div className="border-t border-border/30 px-3 py-2.5 space-y-4">
          {itemsToRender.map((item, idx) => (
            <div key={idx} className="space-y-1">
              <p className="text-sm text-muted-foreground leading-relaxed">
                {item.prompt}
              </p>
              <p className="text-sm font-semibold text-foreground leading-relaxed whitespace-pre-wrap">
                {item.answer || (
                  <span className="italic text-muted-foreground font-normal">
                    {t("sessions.interactionNoAnswer", { defaultValue: "（未回答）" })}
                  </span>
                )}
              </p>
            </div>
          ))}

          {/* Origin tag */}
          {origin && (
            <div className="flex justify-end pt-1">
              <span className="inline-flex items-center rounded-full bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                {originLabel}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
