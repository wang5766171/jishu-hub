// 需求16（v0.9.8）：数据迁移的用户呈现——启动自动执行迁移时的进度条 +
// critical 失败的全屏阻断卡（重试/导出诊断日志）。文案零术语（只说
// 「正在完成升级设置」，不提迁移/脚本/schema）。事件由 Rust migrations
// Runner 发出；刷新后经 migration_status.last_error 兜底重建阻断卡。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand } from "@/hooks/use-invoke";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";

interface MigrationProgress {
  current: number;
  total: number;
  description: string;
}
interface MigrationFailure {
  id: string;
  error: string;
  critical: boolean;
}

export function MigrationOverlay() {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [failure, setFailure] = useState<MigrationFailure | null>(null);
  const [retrying, setRetrying] = useState(false);

  const refreshStatus = useCallback(() => {
    void invokeCommand<{ last_error: MigrationFailure | null }>("migration_status")
      .then((s) => {
        if (s?.last_error) setFailure(s.last_error);
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    // 启动兜底：迁移已在上层 setup 执行；本组件挂载时若已有 critical
    // 失败记录（含刷新前发生），重建阻断卡。
    refreshStatus();
    const unsubs = [
      listen<MigrationProgress>("migration-progress", (e) => setProgress(e.payload)),
      listen("migration-done", () => {
        setProgress(null);
        setFailure(null);
      }),
      listen<MigrationFailure>("migration-failed", (e) => {
        setProgress(null);
        if (e.payload?.critical) setFailure(e.payload);
      }),
    ];
    return () => { void Promise.all(unsubs).then((us) => us.forEach((u) => u())); };
  }, [refreshStatus]);

  if (failure) {
    // critical 失败：全屏阻断（不进主界面——半迁移状态不该被后续写污染）。
    return (
      <div className="fixed inset-0 z-[999] flex items-center justify-center bg-background/95 p-6">
        <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-background p-6 text-center shadow-lg">
          <TriangleAlert className="h-8 w-8 text-amber-500" />
          <h2 className="text-base font-semibold">
            {t("market.migrationFailedTitle", "数据升级未完成")}
          </h2>
          <p className="break-all text-xs text-muted-foreground">{failure.error}</p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                invokeCommand("migration_retry")
                  .then(() => { setFailure(null); })
                  .catch((e) => setFailure((f) => f ?? { id: "", error: String(e), critical: true }))
                  .finally(() => setRetrying(false));
              }}
            >
              {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t("market.migrationRetry", "重试")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                // 诊断信息=完整错误文本入剪贴板（卡上文本亦可选中复制）。
                void navigator.clipboard
                  ?.writeText(`[migration:${failure.id}] ${failure.error}`)
                  .catch(() => null);
              }}
            >
              {t("market.migrationExportLog", "复制诊断信息")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!progress) return null;
  // 进度条：顶部弱化横条（不打断——多数迁移亚秒级完成自然消失）。
  return (
    <div className="fixed inset-x-0 top-0 z-[999] flex items-center justify-center gap-2 bg-primary/10 px-4 py-1.5 text-xs text-foreground backdrop-blur">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
      <span>
        {t("market.migrationProgress", {
          defaultValue: "正在完成升级设置（{{current}}/{{total}}）",
          current: progress.current,
          total: progress.total,
        })}
        {progress.description ? ` · ${progress.description}` : ""}
      </span>
    </div>
  );
}
