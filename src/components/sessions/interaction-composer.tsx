import { useEffect, useMemo, useState } from "react";
import { Check, ListChecks, Send } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { validateInteractionSubmission } from "@/lib/conversation-interaction";
import { cn } from "@/lib/utils";
import type {
  ConversationInteractionRequest,
  ConversationInteractionSubmission,
} from "@/types";

interface InteractionComposerProps {
  request: ConversationInteractionRequest;
  disabled?: boolean;
  submitting?: boolean;
  onSubmit: (submission: ConversationInteractionSubmission) => void | Promise<void>;
}

export function InteractionComposer({
  request,
  disabled = false,
  submitting = false,
  onSubmit,
}: InteractionComposerProps) {
  const { t } = useTranslation();
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [customSelected, setCustomSelected] = useState(false);
  const [customText, setCustomText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedOptionIds([]);
    setCustomSelected(false);
    setCustomText("");
    setError(null);
  }, [request.requestId]);

  const selectedOptionSet = useMemo(
    () => new Set(selectedOptionIds),
    [selectedOptionIds],
  );

  const toggleOption = (optionId: string) => {
    setError(null);
    setCustomSelected(false);
    setSelectedOptionIds((current) => {
      if (!request.allowMultiple) {
        return current[0] === optionId ? [] : [optionId];
      }
      return current.includes(optionId)
        ? current.filter((currentId) => currentId !== optionId)
        : [...current, optionId];
    });
  };

  const toggleCustom = () => {
    setError(null);
    setCustomSelected((selected) => {
      const next = !selected;
      if (next && !request.allowMultiple) {
        setSelectedOptionIds([]);
      }
      return next;
    });
  };

  const submit = async () => {
    try {
      const submission = validateInteractionSubmission(request, {
        selectedOptionIds,
        customText,
      });
      setError(null);
      await onSubmit(submission);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : t("sessions.interactionInvalid"),
      );
    }
  };

  return (
    <section
      className="border-b border-border/55 bg-muted/45"
      aria-labelledby={`interaction-${request.requestId}`}
    >
      <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4 py-3">
      <div className="mb-2.5 flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/75 text-[var(--icon-action)] shadow-xs">
          <ListChecks className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t("sessions.interactionPending")}
          </p>
          <p
            id={`interaction-${request.requestId}`}
            className="mt-0.5 text-sm font-medium leading-5 text-foreground"
          >
            {request.prompt}
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {request.options.map((option, index) => {
          const selected = selectedOptionSet.has(option.optionId);
          return (
            <button
              key={option.optionId}
              type="button"
              aria-pressed={selected}
              disabled={disabled || submitting}
              onClick={() => toggleOption(option.optionId)}
              className={cn(
                "flex min-h-12 items-start gap-2.5 rounded-[6px] border px-3 py-2.5 text-left transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                selected
                  ? "border-primary/55 bg-primary/10 text-foreground shadow-xs"
                  : "border-border/65 bg-background/65 text-foreground hover:border-primary/35 hover:bg-accent/45",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-5 min-w-5 items-center justify-center rounded-md border px-1 text-[10px] font-bold",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-muted/70 text-muted-foreground",
                )}
              >
                {selected ? <Check className="h-3 w-3" /> : String.fromCharCode(65 + index)}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{option.label}</span>
                {option.description ? (
                  <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
        {request.allowCustomText && request.options.length > 0 ? (
          <button
            type="button"
            aria-pressed={customSelected}
            disabled={disabled || submitting}
            onClick={toggleCustom}
            className={cn(
              "flex min-h-12 items-start gap-2.5 rounded-[6px] border px-3 py-2.5 text-left transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              customSelected
                ? "border-primary/55 bg-primary/10 text-foreground shadow-xs"
                : "border-border/65 bg-background/65 text-foreground hover:border-primary/35 hover:bg-accent/45",
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex h-5 min-w-5 items-center justify-center rounded-md border px-1 text-[10px] font-bold",
                customSelected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-muted/70 text-muted-foreground",
              )}
            >
              {customSelected ? <Check className="h-3 w-3" /> : String.fromCharCode(65 + request.options.length)}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {t("sessions.interactionOtherOption")}
              </span>
            </span>
          </button>
        ) : null}
      </div>

      {request.allowCustomText && (customSelected || request.options.length === 0) ? (
        <textarea
          value={customText}
          onChange={(event) => {
            setCustomText(event.target.value);
            setError(null);
          }}
          disabled={disabled || submitting}
          rows={2}
          placeholder={t("sessions.interactionCustomPlaceholder")}
          className="mt-2.5 min-h-16 w-full resize-none rounded-[6px] border border-input bg-background/70 px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
        />
      ) : null}

      <div className="mt-2.5 flex items-center justify-between gap-3">
        <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
          {error
            ? t(`sessions.interactionErrors.${error}`, { defaultValue: error })
            : request.allowMultiple
              ? t("sessions.interactionMultipleHint")
              : t("sessions.interactionSingleHint")}
        </p>
        <Button
          type="button"
          size="sm"
          disabled={disabled || submitting}
          onClick={submit}
          className="rounded-full px-4"
        >
          <Send className="h-3.5 w-3.5" />
          {submitting
            ? t("sessions.interactionSubmitting")
            : t("sessions.interactionSubmit")}
        </Button>
      </div>
      </div>
    </section>
  );
}
