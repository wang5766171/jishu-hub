import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, MessageCircleQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import { dedupeInteractionItems } from "@/lib/interaction-tools";

export interface InteractionCardOption {
  option_id: string;
  label: string;
  description?: string | null;
}

export interface InteractionCardItem {
  prompt: string;
  options?: InteractionCardOption[];
  answer: string;
  selectedOptions?: string[];
}

export interface InteractionCardProps {
  items: InteractionCardItem[];
  origin?: string;
}

function useOriginLabel(origin: string | undefined): string | null {
  const { t } = useTranslation();
  return useMemo(() => {
    if (!origin) return null;
    switch (origin) {
      case "extension_ui":
        return t("sessions.interactionOriginBuiltIn", { defaultValue: "Built-in assistant" });
      case "acp_elicitation":
      case "codex_tool_request_user_input":
        return t("sessions.interactionOriginExternal", { defaultValue: "External assistant" });
      default:
        return t("sessions.interactionOriginGeneric", { defaultValue: "Assistant question" });
    }
  }, [origin, t]);
}

export const InteractionCard = memo(function InteractionCard({
  items,
  origin,
  defaultOpen = false,
}: InteractionCardProps & { defaultOpen?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const originLabel = useOriginLabel(origin);
  const itemsToRender = useMemo(() => dedupeInteractionItems(items), [items]);

  return (
    <div
      className={cn(
        "w-full max-w-full rounded-[6px] border transition-colors",
        open
          ? "border-primary/30 bg-primary/[0.03]"
          : "border-border/50 bg-muted/20 hover:border-border/70",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left select-none"
      >
        <MessageCircleQuestion className="h-4 w-4 shrink-0 text-primary/70" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {t("sessions.interactionDefault", { defaultValue: "Ask user" })}
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="space-y-4 border-t border-border/30 px-3 py-2.5">
          {itemsToRender.map((item, idx) => (
            <div key={idx} className="space-y-1">
              <p className="text-sm leading-relaxed text-muted-foreground">
                {item.prompt}
              </p>
              <p className="whitespace-pre-wrap text-sm font-semibold leading-relaxed text-foreground">
                {item.answer || (
                  <span className="font-normal italic text-muted-foreground">
                    {t("sessions.interactionNoAnswer", { defaultValue: "(No answer)" })}
                  </span>
                )}
              </p>
            </div>
          ))}

          {originLabel && (
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
