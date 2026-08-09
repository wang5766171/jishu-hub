import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { useAgent } from "@/agents";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import type { BackupEntry } from "@/types";

interface BackupManagerProps {
  onRestored: () => void;
}

export function BackupManager({ onRestored }: BackupManagerProps) {
  const { t } = useTranslation();
  // v0.7.0 需求一：管理作用域 agent_id（list_backups / restore_backup 必填）。
  const { manageAgentId } = useAgent();
  const { data: backups, loading, refetch } = useInvoke<BackupEntry[]>(
    manageAgentId ? "list_backups" : "",
    manageAgentId ? { agentId: manageAgentId } : undefined,
  );
  const [restoring, setRestoring] = useState<string | null>(null);

  const handleRestore = async (backup: BackupEntry) => {
    setRestoring(backup.path);
    try {
      await invokeCommand("restore_backup", { agentId: manageAgentId ?? "", backupPath: backup.path });
      onRestored();
      refetch();
    } catch (err) {
      console.error("Failed to restore backup:", err);
    } finally {
      setRestoring(null);
    }
  };

  if (loading) {
    return <div className="text-muted-foreground">{t("config.loadingBackups")}</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("config.backupDesc")}
      </p>

      {!backups || backups.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-muted-foreground">
          <p>{t("config.noBackups")}</p>
          <p className="text-sm">{t("config.noBackupsDesc")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {backups.map((backup) => (
            <div
              key={backup.name}
              className="flex items-center justify-between rounded-md border px-4 py-3"
            >
              <div className="space-y-1">
                <span className="text-sm font-medium">{backup.timestamp || backup.name}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleRestore(backup)}
                disabled={restoring === backup.path}
              >
                <RotateCcw className="mr-2 h-3 w-3" />
                {restoring === backup.path ? t("config.restoring") : t("config.restore")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
