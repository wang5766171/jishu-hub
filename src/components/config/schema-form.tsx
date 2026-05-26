import { memo, useCallback } from "react";
import { cn } from "@/lib/utils";

// --- Schema types ---

export interface SchemaOption {
  value: string;
  label: string;
}

export interface SchemaField {
  type: "text" | "select" | "switch" | "number" | "kv_list" | "string_list" | "group";
  key: string;
  label: string;
  default?: unknown;
  secret?: boolean;
  options?: SchemaOption[];
  min?: number;
  max?: number;
  hint?: string;
  secret_keys?: string[];
  children?: SchemaField[];
}

export interface SchemaSection {
  id: string;
  title: string;
  description?: string;
  fields: SchemaField[];
}

export interface AgentSchema {
  global: { sections: SchemaSection[] };
  project?: { sections: SchemaSection[] };
}

// --- Helpers ---

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split(".");
  const result = { ...obj };
  let current: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    current[parts[i]] = { ...(current[parts[i]] as Record<string, unknown> ?? {}) };
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  return result;
}

// --- Field renderers ---

const TextField = memo(function TextField({
  field, value, onChange,
}: { field: SchemaField; value: unknown; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">{field.label}</label>
      <input
        type={field.secret ? "password" : "text"}
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2.5 py-1.5 rounded-md border border-border bg-card text-sm outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  );
});

const SelectField = memo(function SelectField({
  field, value, onChange,
}: { field: SchemaField; value: unknown; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">{field.label}</label>
      <select
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2.5 py-1.5 rounded-md border border-border bg-card text-sm outline-none focus:ring-1 focus:ring-ring"
      >
        {field.options?.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
});

const SwitchField = memo(function SwitchField({
  field, value, onChange,
}: { field: SchemaField; value: unknown; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={(value as boolean) ?? field.default as boolean ?? false}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-border"
      />
      <span className="text-xs font-medium text-foreground">{field.label}</span>
    </label>
  );
});

const NumberField = memo(function NumberField({
  field, value, onChange,
}: { field: SchemaField; value: unknown; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">{field.label}</label>
      <input
        type="number"
        min={field.min}
        max={field.max}
        value={(value as number) ?? ""}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full px-2.5 py-1.5 rounded-md border border-border bg-card text-sm outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  );
});

const StringListField = memo(function StringListField({
  field, value, onChange,
}: { field: SchemaField; value: unknown; onChange: (v: string[]) => void }) {
  const items = (value as string[]) ?? [];
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">{field.label}</label>
      {field.hint && <p className="text-[10px] text-muted-foreground">{field.hint}</p>}
      <div className="space-y-1">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              type="text"
              value={item}
              onChange={(e) => {
                const next = [...items];
                next[i] = e.target.value;
                onChange(next);
              }}
              className="flex-1 px-2 py-1 rounded border border-border bg-card text-xs outline-none"
            />
            <button
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              className="text-xs text-destructive hover:text-destructive/80"
            >
              x
            </button>
          </div>
        ))}
        <button
          onClick={() => onChange([...items, ""])}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          + Add
        </button>
      </div>
    </div>
  );
});

const KvListField = memo(function KvListField({
  field, value, onChange,
}: { field: SchemaField; value: unknown; onChange: (v: Record<string, string>) => void }) {
  const entries = Object.entries((value as Record<string, string>) ?? {});
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">{field.label}</label>
      <div className="space-y-1">
        {entries.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              type={field.secret_keys?.includes(k) ? "password" : "text"}
              value={k}
              onChange={(e) => {
                const next: Record<string, string> = {};
                entries.forEach(([ek, ev], j) => {
                  next[j === i ? e.target.value : ek] = ev;
                });
                onChange(next);
              }}
              className="w-1/3 px-2 py-1 rounded border border-border bg-card text-xs outline-none"
              placeholder="Key"
            />
            <input
              type="text"
              value={v}
              onChange={(e) => {
                const next: Record<string, string> = {};
                entries.forEach(([ek, ev], j) => {
                  next[ek] = j === i ? e.target.value : ev;
                });
                onChange(next);
              }}
              className="flex-1 px-2 py-1 rounded border border-border bg-card text-xs outline-none"
              placeholder="Value"
            />
            <button
              onClick={() => {
                const next: Record<string, string> = {};
                entries.forEach(([ek, ev], j) => { if (j !== i) next[ek] = ev; });
                onChange(next);
              }}
              className="text-xs text-destructive hover:text-destructive/80"
            >
              x
            </button>
          </div>
        ))}
        <button
          onClick={() => onChange({ ...(value as Record<string, string> ?? {}), "": "" })}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          + Add
        </button>
      </div>
    </div>
  );
});

// --- Main components ---

function FieldRenderer({
  field, value, onChange,
}: {
  field: SchemaField;
  value: unknown;
  onChange: (updated: Record<string, unknown>) => void;
}) {
  const fieldValue = typeof value === "object" && value !== null ? getByPath(value as Record<string, unknown>, field.key) : undefined;

  const handleChange = useCallback((v: unknown) => {
    const current = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    onChange(setByPath(current, field.key, v));
  }, [value, field.key, onChange]);

  switch (field.type) {
    case "text":
      return <TextField field={field} value={fieldValue} onChange={(v) => handleChange(v)} />;
    case "select":
      return <SelectField field={field} value={fieldValue} onChange={(v) => handleChange(v)} />;
    case "switch":
      return <SwitchField field={field} value={fieldValue} onChange={(v) => handleChange(v)} />;
    case "number":
      return <NumberField field={field} value={fieldValue} onChange={(v) => handleChange(v)} />;
    case "kv_list":
      return <KvListField field={field} value={fieldValue} onChange={(v) => handleChange(v)} />;
    case "string_list":
      return <StringListField field={field} value={fieldValue} onChange={(v) => handleChange(v)} />;
    case "group":
      return (
        <fieldset className="border border-border rounded-md p-3 space-y-2">
          <legend className="text-xs font-medium text-foreground px-1">{field.label}</legend>
          {field.children?.map((child) => (
            <FieldRenderer
              key={child.key}
              field={child}
              value={fieldValue ?? value}
              onChange={onChange}
            />
          ))}
        </fieldset>
      );
    default:
      return null;
  }
}

export const SchemaForm = memo(function SchemaForm({
  schema,
  value,
  onChange,
}: {
  schema: AgentSchema;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-4">
      {schema.global.sections.map((section) => (
        <div key={section.id} className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
            {section.description && (
              <p className="text-[11px] text-muted-foreground mt-0.5">{section.description}</p>
            )}
          </div>
          <div className="space-y-3 pl-1">
            {section.fields.map((field) => (
              <FieldRenderer
                key={field.key}
                field={field}
                value={value}
                onChange={onChange}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
});
