import { useState, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { McpServerConfig } from "@/types";

interface McpEditorBaseProps {
  value: Record<string, McpServerConfig> | null;
  /** v0.8.0 需求9 收尾：上报解析态与错误态，宿主可在页头渲染保存按钮。 */
  onStateChange?: (state: { value: Record<string, McpServerConfig> | null; hasError: boolean }) => void;
}

/**
 * Render-props mode: exposes parsed value and error state so the parent
 * can control when to save. Actions render in a row below the textarea.
 */
interface McpEditorActionsProps extends McpEditorBaseProps {
  /** v0.8.0 需求9 收尾：可选——不传时编辑器无工具栏，保存按钮由宿主经
      onStateChange 放到页头。 */
  actions?: (state: { value: Record<string, McpServerConfig> | null; hasError: boolean }) => ReactNode;
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

  // v0.8.0 需求9 收尾：向宿主（页头保存按钮）上报解析态。
  useEffect(() => {
    props.onStateChange?.({ value: parsedValue, hasError: !!error });
  }, [parsedValue, error, props.onStateChange]);

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
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
        <div className="flex-1">
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{t("config.mcpJsonHint")}</p>
          )}
        </div>
        {actions && (
          <div className="flex-shrink-0">
            {actions({ value: parsedValue, hasError: !!error })}
          </div>
        )}
      </div>
      <textarea
        className="h-56 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        value={json}
        onChange={(e) => handleChange(e.target.value)}
        spellCheck={false}
        placeholder='{"server-name":{"type":"local","command":["npx","-y","@example/mcp"]}}'
      />
      <div className="h-2" />
    </div>
  );
}
