import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { McpServerConfig } from "@/types";

interface McpEditorProps {
  value: Record<string, McpServerConfig> | null;
  onChange: (value: Record<string, McpServerConfig> | null) => void;
  /** Called when parse error state changes (for external save button enable/disable) */
  onErrorChange?: (hasError: boolean) => void;
}

/**
 * Reusable JSON textarea editor for MCP server definitions.
 * Controlled component: fires onChange on every valid parse.
 */
export function McpEditor({ value, onChange, onErrorChange }: McpEditorProps) {
  const { t } = useTranslation();
  const [json, setJson] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState("");

  // Sync when the external value changes (e.g. template applied, saved)
  useEffect(() => {
    setJson(JSON.stringify(value ?? {}, null, 2));
    setError("");
    onErrorChange?.(false);
  }, [value]);

  const handleChange = (text: string) => {
    setJson(text);
    if (!text.trim()) {
      setError("");
      onErrorChange?.(false);
      onChange(null);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        setError(t("config.invalidJson"));
        onErrorChange?.(true);
        return;
      }
      setError("");
      onErrorChange?.(false);
      onChange(parsed as Record<string, McpServerConfig>);
    } catch {
      setError(t("config.invalidJson"));
      onErrorChange?.(true);
    }
  };

  return (
    <div className="space-y-2 pt-2">
      <textarea
        className="h-56 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        value={json}
        onChange={(e) => handleChange(e.target.value)}
        spellCheck={false}
        placeholder='{"server-name":{"type":"local","command":["npx","-y","@example/mcp"]}}'
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{t("config.mcpJsonHint")}</p>
      )}
    </div>
  );
}
