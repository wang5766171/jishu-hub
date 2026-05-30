import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { Button } from "@/components/ui/button";
import { Save, RotateCcw } from "lucide-react";

interface RawConfigEditorProps {
  initialContent: string;
  format: string;
  onSaved: () => void;
}

export function RawConfigEditor({ initialContent, format, onSaved }: RawConfigEditorProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = content !== initialContent;

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await invokeCommand("save_raw_config", { content });
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [content, onSaved]);

  const handleReset = useCallback(() => {
    setContent(initialContent);
    setError(null);
  }, [initialContent]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground uppercase font-mono px-2 py-0.5 bg-muted rounded">
            {format}
          </span>
          {dirty && (
            <span className="text-xs text-amber-500">{t("config.unsaved")}</span>
          )}
        </div>
        <div className="flex gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" onClick={handleReset}>
              <RotateCcw className="mr-1 h-3 w-3" />
              {t("config.reset")}
            </Button>
          )}
          <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
            <Save className="mr-1 h-3 w-3" />
            {saving ? t("config.saving") : t("config.save")}
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-xs text-destructive bg-destructive/10 p-2 rounded border border-destructive/20 mb-3">
          {error}
        </div>
      )}

      <textarea
        className="flex-1 min-h-0 w-full rounded-lg border border-border bg-card p-4 font-mono text-sm leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-ring/30"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}
