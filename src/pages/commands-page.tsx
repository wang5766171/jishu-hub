import { useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { AddCommandDialog } from "@/components/commands/add-command-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Play, Pencil, Trash2, Terminal } from "lucide-react";
import { useAgent } from "@/agents";
import type { AgentCommandPreset, CustomCommand } from "@/types";

const COOLDOWN_MS = 2000;

export function CommandsPage() {
  const { t } = useTranslation();
  const { activeId, active } = useAgent();
  const { data: commands, loading, refetch } = useInvoke<CustomCommand[]>("list_custom_commands");
  const agentRefreshKey = activeId ? Array.from(activeId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) : 0;
  const { data: builtInCommands } = useInvoke<AgentCommandPreset[]>("agent_command_presets", undefined, agentRefreshKey);
  const [addOpen, setAddOpen] = useState(false);
  const [editCmd, setEditCmd] = useState<CustomCommand | null>(null);
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleRun = useCallback(async (key: string, cmd: string, cwd?: string | null) => {
    if (runningKey) return;
    setRunningKey(key);
    try {
      await invokeCommand("run_in_terminal", {
        commandStr: cmd,
        cwd: cwd || undefined,
      });
    } catch (err) {
      console.error("Failed to run command:", err);
    }
    timerRef.current = setTimeout(() => setRunningKey(null), COOLDOWN_MS);
  }, [runningKey]);

  const handleDelete = async (id: string) => {
    await invokeCommand("delete_custom_command", { id });
    refetch();
  };

  const handleEdit = (cmd: CustomCommand) => {
    setEditCmd(cmd);
    setAddOpen(true);
  };

  const handleAddNew = () => {
    setEditCmd(null);
    setAddOpen(true);
  };

  const handleSaved = () => {
    refetch();
    setEditCmd(null);
  };

  const visibleCommands = (commands ?? []).filter((cmd) => !cmd.agentId || cmd.agentId === activeId);

  if (loading) {
    return <Skeleton className="h-64" />;
  }

  return (
    <div className="space-y-6 p-6 h-full overflow-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{t("commands.title")}</h2>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleAddNew}>
            <Plus className="mr-2 h-4 w-4" />
            {t("commands.addCommand")}
          </Button>
        </div>
      </div>

      {/* Built-in commands */}
      <div className="space-y-3">
        <h3 className="sm font-medium text-muted-foreground">{t("commands.builtIn")}</h3>
        <div className="space-y-2">
          {(builtInCommands ?? []).map((cmd) => (
            <div key={cmd.name} className="flex items-center justify-between rounded-md border px-4 py-3">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-mono">{cmd.name}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleRun(cmd.name, cmd.command)}
                disabled={runningKey === cmd.name}
              >
                <Play className="mr-1 h-3 w-3" />
                {runningKey === cmd.name ? t("commands.running") : t("commands.run")}
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* Custom commands */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">{t("commands.custom")}</h3>
        {visibleCommands.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center text-muted-foreground">
            <p>{t("commands.noCommands")}</p>
            <p className="text-sm">{t("commands.noCommandsDesc")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {visibleCommands.map((cmd) => (
              <div key={cmd.id} className="flex items-center justify-between rounded-md border px-4 py-3">
                <div className="space-y-1 min-w-0">
                  <span className="text-sm font-medium">{cmd.name}</span>
                  <p className="text-xs font-mono text-muted-foreground truncate">{cmd.command}</p>
                  {cmd.projectPath && (
                    <p className="text-xs text-muted-foreground">{cmd.projectPath}</p>
                  )}
                </div>
                <div className="flex gap-1 shrink-0 ml-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRun(cmd.id, cmd.command, cmd.projectPath)}
                    disabled={runningKey === cmd.id}
                  >
                    <Play className="mr-1 h-3 w-3" />
                    {runningKey === cmd.id ? t("commands.running") : t("commands.run")}
                  </Button>
                  <Button variant="ghost" size="icon-xs" onClick={() => handleEdit(cmd)}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon-xs" onClick={() => handleDelete(cmd.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <AddCommandDialog
        open={addOpen}
        onOpenChange={(open) => { setAddOpen(open); if (!open) setEditCmd(null); }}
        editCommand={editCmd}
        agentId={activeId}
        onSaved={handleSaved}
      />
    </div>
  );
}
