import type { GraphNode } from "./use-task-graph";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

interface NodeSidebarProps {
  node: GraphNode | null;
  onClose: () => void;
}

export function NodeSidebar({ node, onClose }: NodeSidebarProps) {
  const { t } = useTranslation();
  if (!node) {
    return null;
  }

  return (
    <div className="w-80 h-full border-l border-border bg-background p-4 overflow-y-auto">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold truncate">{node.title}</h3>
        <button
          type="button"
          onClick={onClose}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("tasks.workbench.closeNodeInspector")}
          title={t("tasks.workbench.closeNodeInspector")}
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-4 text-sm">
        <div>
          <span className="font-medium text-muted-foreground">{t("tasks.workbench.nodeId")}: </span>
          <span className="break-all">{node.node_id}</span>
        </div>
        <div>
          <span className="font-medium text-muted-foreground">{t("tasks.workbench.nodeKind")}: </span>
          <span className="bg-secondary text-secondary-foreground px-2 py-0.5 rounded text-xs uppercase">
            {t(`tasks.workbench.nodeKinds.${node.node_kind}`)}
          </span>
        </div>
        
        {node.description && (
          <div>
            <span className="font-medium text-muted-foreground">{t("tasks.workbench.description")}: </span>
            <p className="mt-1 text-foreground/90">{node.description}</p>
          </div>
        )}

        {node.executable_payload && (
          <div>
            <span className="font-medium text-muted-foreground">{t("tasks.workbench.payload")}: </span>
            <pre className="mt-1 bg-secondary p-2 rounded text-xs overflow-x-auto text-secondary-foreground">
              {JSON.stringify(node.executable_payload, null, 2)}
            </pre>
          </div>
        )}

        {node.loop_config && (
          <div>
            <span className="font-medium text-muted-foreground">{t("tasks.workbench.loopConfig")}: </span>
            <pre className="mt-1 bg-secondary p-2 rounded text-xs overflow-x-auto text-secondary-foreground">
              {JSON.stringify(node.loop_config, null, 2)}
            </pre>
          </div>
        )}

        {node.approval_gate_config && (
          <div>
            <span className="font-medium text-muted-foreground">{t("tasks.workbench.approvalGate")}: </span>
            <pre className="mt-1 bg-secondary p-2 rounded text-xs overflow-x-auto text-secondary-foreground">
              {JSON.stringify(node.approval_gate_config, null, 2)}
            </pre>
          </div>
        )}

        <div>
          <span className="font-medium text-muted-foreground">{t("tasks.workbench.contracts")}: </span>
          <div className="mt-1 space-y-2">
            <div className="bg-secondary/50 p-2 rounded text-xs">
              <div className="font-semibold mb-1">{t("tasks.workbench.input")}</div>
              <pre className="overflow-x-auto text-muted-foreground">
                {JSON.stringify(node.input_contract, null, 2)}
              </pre>
            </div>
            <div className="bg-secondary/50 p-2 rounded text-xs">
              <div className="font-semibold mb-1">{t("tasks.workbench.output")}</div>
              <pre className="overflow-x-auto text-muted-foreground">
                {JSON.stringify(node.output_contract, null, 2)}
              </pre>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
