/**
 * ExecutionChatScopeTabs —— 执行阶段会话范围切换（主任务 / 各节点子代理）。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §4.3、§4.5。
 * 与展现形式（executionView）正交，控制对话面板的数据源。
 */
import { Radio, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ExecutionChatScope, NodeSessionInfo } from "./types";

interface ExecutionChatScopeTabsProps {
  scope: ExecutionChatScope;
  /** 节点会话缓存（来自 useTaskInstance.nodeSessionMap）。 */
  nodeSessions: Record<string, NodeSessionInfo>;
  /** 节点标题映射（nodeId → title，来自图快照）。 */
  nodeTitles: Record<string, string>;
  /** 当前 run 是否活跃（用于主任务 Tab 显示 🔴 live）。 */
  runActive: boolean;
  onChange: (scope: ExecutionChatScope) => void;
}

export function ExecutionChatScopeTabs({
  scope,
  nodeSessions,
  nodeTitles,
  runActive,
  onChange,
}: ExecutionChatScopeTabsProps) {
  const { t } = useTranslation();
  const nodeIds = Object.keys(nodeSessions);

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 py-1">
      <button
        type="button"
        onClick={() => onChange({ kind: "run" })}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors",
          scope.kind === "run"
            ? "bg-primary/10 font-medium text-primary"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        {runActive && scope.kind === "run" ? (
          <Radio className="h-3 w-3 animate-pulse text-orange-500" />
        ) : (
          <Square className="h-2.5 w-2.5 rounded-[2px] bg-current" />
        )}
        {t("task.execution.mainSession", "主任务")}
      </button>

      {nodeIds.map((nodeId) => {
        const info = nodeSessions[nodeId];
        const title = nodeTitles[nodeId] ?? nodeId;
        const active = scope.kind === "node" && scope.nodeId === nodeId;
        return (
          <button
            key={nodeId}
            type="button"
            onClick={() => onChange({ kind: "node", nodeId, attemptNumber: info.attempt_number })}
            title={info.agent_id ? `agent: ${info.agent_id}` : undefined}
            className={cn(
              "shrink-0 truncate rounded px-2 py-1 text-[11px] transition-colors",
              active
                ? "bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {title}
          </button>
        );
      })}
    </div>
  );
}
