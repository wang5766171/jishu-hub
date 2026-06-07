import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { McpServerConfig } from "@/types";

interface McpEditorProps {
  value: Record<string, McpServerConfig> | null;
  onChange: (value: Record<string, McpServerConfig> | null) => void;
  /** If true, render as a standalone section with its own heading. Default: false (inline). */
  standalone?: boolean;
}

/**
 * Reusable JSON textarea editor for MCP server definitions.
 * Internal state: raw JSON string + validation error.
 * External interface: parsed object via onChange callback.
 */
export function McpEditor({ value, onChange, standalone = false }: McpEditorProps) {
  const { t } = useTranslation();
  const [json, setJson] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState("");

  // Sync when the external value changes (e.g. template applied)
  useEffect(() => {
    setJson(JSON.stringify(value ?? {}, null, 2));
    setError("");
  }, [value]);

  const handleChange = (text: string) => {
    setJson(text);
    if (!text.trim()) {
      setError("");
      onChange(null);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        setError(t("config.invalidJson"));
        return;
      }
      setError("");
      onChange(parsed as Record<string, McpServerConfig>);
    } catch {
      setError(t("config.invalidJson"));
    }
  };

  const textarea = (
    <textarea
      className="h-56 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      value={json}
      onChange={(e) => handleChange(e.target.value)}
      spellCheck={false}
      placeholder='{"server-name":{"type":"local","command":["npx","-y","@example/mcp"]}}'
    />
  );

  const status = error ? (
    <p className="text-xs text-destructive">{error}</p>
  ) : (
    <p className="text-xs text-muted-foreground">{t("config.mcpJsonHint")}</p>
  );

  if (standalone) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("config.mcpServers")}</h3>
        {textarea}
        {status}
      </div>
    );
  }

  return (
    <div className="space-y-2 pt-2">
      {textarea}
      {status}
    </div>
  );
}
