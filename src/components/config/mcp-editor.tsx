import { useState, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { McpServerConfig } from "@/types";

interface McpEditorBaseProps {
  value: Record<string, McpServerConfig> | null;
}

/**
 * Render-props mode: exposes parsed value and error state so the parent
 * can control when to save. Actions render in a row below the textarea.
 */
interface McpEditorActionsProps extends McpEditorBaseProps {
  actions: (state: { value: Record<string, McpServerConfig> | null; hasError: boolean }) => ReactNode;
  onChange?: never;
}

/**
 * Controlled mode: calls onChange on every valid edit (used by ConfigForm).
 */
interface McpEditorControlledProps extends McpEditorBaseProps {
  onChange: (value: Record<string, McpServerConfig> | null) => void;
  actions?: never;
}

type McpEditorProps = McpEditorActionsProps | McpEditorControlledProps;

/**
 * Reusable JSON textarea editor for MCP server definitions.
 *
 * Supports two modes:
 * - **Controlled** (onChange): fires on every valid parse (for ConfigForm).
 * - **Actions** (actions render prop): exposes `{ value, hasError }` so
 *   the parent renders its own save button.
 */
export function McpEditor(props: McpEditorProps) {
  const { value } = props;
  const isControlled = "onChange" in props && !!props.onChange;
  const onChange = isControlled ? (props as McpEditorControlledProps).onChange : undefined;
  const actions = !isControlled ? (props as McpEditorActionsProps).actions : undefined;

  const { t } = useTranslation();
  const [json, setJson] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState("");
  const [parsedValue, setParsedValue] = useState<Record<string, McpServerConfig> | null>(value ?? null);

  // Sync when the external value changes (e.g. template applied, saved)
  useEffect(() => {
    setJson(JSON.stringify(value ?? {}, null, 2));
    setError("");
    setParsedValue(value ?? null);
  }, [value]);

  const handleChange = (text: string) => {
    setJson(text);
    if (!text.trim()) {
      setError("");
      setParsedValue(null);
      onChange?.(null);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        setError(t("config.invalidJson"));
        setParsedValue(null);
        return;
      }
      setError("");
      const result = parsed as Record<string, McpServerConfig>;
      setParsedValue(result);
      onChange?.(result);
    } catch {
      setError(t("config.invalidJson"));
      setParsedValue(null);
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
      {actions && (
        <div className="flex items-center gap-2 pt-1">
          {actions({ value: parsedValue, hasError: !!error })}
        </div>
      )}
    </div>
  );
}
