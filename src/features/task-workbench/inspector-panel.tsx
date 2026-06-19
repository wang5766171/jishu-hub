import { useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { Box, FileText, ListChecks, MessageSquareText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GraphNode } from "./use-task-graph";

type InspectorTab = "overview" | "run" | "conversation" | "artifacts";

interface InspectorPanelProps {
  node: GraphNode | null;
  onClose: () => void;
}

export function InspectorPanel({ node, onClose }: InspectorPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<InspectorTab>("overview");

  if (!node) return null;

  const tabs: Array<{
    id: InspectorTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: "overview", label: t("tasks.workbench.unifiedInspector.tabs.overview"), icon: ListChecks },
    { id: "run", label: t("tasks.workbench.unifiedInspector.tabs.run"), icon: FileText },
    { id: "conversation", label: t("tasks.workbench.unifiedInspector.tabs.conversation"), icon: MessageSquareText },
    { id: "artifacts", label: t("tasks.workbench.unifiedInspector.tabs.artifacts"), icon: Box },
  ];

  return (
    <aside className="flex h-full w-[22rem] shrink-0 flex-col border-l border-border bg-background">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("tasks.workbench.unifiedInspector.title")}
          </div>
          <div className="mt-1 truncate text-sm font-semibold">{node.title}</div>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={onClose}
          aria-label={t("tasks.workbench.closeNodeInspector")}
          title={t("tasks.workbench.closeNodeInspector")}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="grid grid-cols-4 border-b border-border text-xs">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                "flex min-h-12 flex-col items-center justify-center gap-1 px-1 py-2 transition",
                tab === item.id
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
        {tab === "overview" && (
          <div className="space-y-4">
            <Field label={t("tasks.workbench.nodeId")} value={node.node_id} />
            <Field
              label={t("tasks.workbench.nodeKind")}
              value={t(`tasks.workbench.nodeKinds.${node.node_kind}`)}
            />
            {node.description && (
              <Field label={t("tasks.workbench.description")} value={node.description} />
            )}
            <JsonBlock label={t("tasks.workbench.input")} value={node.input_contract} />
            <JsonBlock label={t("tasks.workbench.output")} value={node.output_contract} />
          </div>
        )}
        {tab !== "overview" && (
          <div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            {t("tasks.workbench.unifiedInspector.phase1Placeholder")}
          </div>
        )}
      </div>
    </aside>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-foreground">{value}</div>
    </div>
  );
}

function JsonBlock({
  label,
  value,
}: {
  label: string;
  value: Record<string, unknown>;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <pre className="mt-1 max-h-36 overflow-auto rounded-md bg-muted p-2 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
