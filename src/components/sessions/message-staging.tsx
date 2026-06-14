/**
 * Shared message staging area — used by regular chat and task planning.
 *
 * When the agent is running, the user can type content that goes into the
 * staging area (not sent immediately). Staged messages can be:
 * - Edited (inline)
 * - Deleted
 * - Sent as "guide/steer" (for Jishu Agent: Pi steer; for others: stop+send)
 *
 * Reference: Codex Desktop's input behavior during agent output.
 */
import { useState } from "react";
import { Edit3, Send, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export interface StagedMessage {
  id: string;
  content: string;
}

interface MessageStagingProps {
  messages: StagedMessage[];
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onSend: (id: string, content: string) => void;
  sendLabel?: string;
}

export function MessageStaging({
  messages,
  onEdit,
  onDelete,
  onSend,
  sendLabel,
}: MessageStagingProps) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  if (messages.length === 0) return null;

  const startEdit = (msg: StagedMessage) => {
    setEditingId(msg.id);
    setEditText(msg.content);
  };

  const confirmEdit = () => {
    if (editingId && editText.trim()) {
      onEdit(editingId, editText.trim());
    }
    setEditingId(null);
    setEditText("");
  };

  return (
    <div className="space-y-2">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2"
        >
          {editingId === msg.id ? (
            <div className="min-w-0 flex-1 space-y-2">
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={2}
                autoFocus
                className="w-full resize-none rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={confirmEdit}
                  disabled={!editText.trim()}
                  className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground disabled:opacity-40"
                >
                  {t("common.confirm")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="min-w-0 flex-1 text-xs leading-5 text-foreground">
                {msg.content}
              </p>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => startEdit(msg)}
                  title={t("common.edit")}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Edit3 className="size-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(msg.id)}
                  title={t("common.delete")}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                >
                  <Trash2 className="size-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onSend(msg.id, msg.content)}
                  disabled={false}
                  className={cn(
                    "flex items-center gap-1 rounded bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90",
                  )}
                  title={sendLabel ?? t("sessions.interactionSubmit")}
                >
                  <Send className="size-3" />
                  {sendLabel ?? t("tasks.workbench.planningProgress.steer")}
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
