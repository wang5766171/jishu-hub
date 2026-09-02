import { useCallback, useEffect, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { AgentLogo, useAgent } from "@/agents";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useTranslation } from "react-i18next";
import { AlertCircle, Download, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AgentStatus } from "@/agents/types";
import { PluginCreateDialog } from "./plugin-create-dialog";

/** v0.8.1 需求3：插件管理页。数据源 plugin_list（需求2 的统一插件模型），
 * 启停/卸载/重载均热生效（后端重建 registry，无需重启应用）。
 * v0.8.1 需求5：承接原环境检测页的智能体安装检测（未安装展示安装命令与
 * 一键安装；核心引擎仍走环境检测页）。 */
interface PluginDescriptor {
  id: string;
  display_name: string;
  kind: "builtin" | "manifest" | "tool";
  version: string | null;
  source_path: string | null;
  core: boolean;
  enabled: boolean;
}

interface PluginListResult {
  plugins: PluginDescriptor[];
  manifest_errors: [string, string][];
}

export function PluginsPage() {
  const { t } = useTranslation();
  const { alert: alertDialog, confirm: confirmDialog, dialogNode } = useConfirmDialog();
  const { agents, refreshHealth } = useAgent();
  const [result, setResult] = useState<PluginListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  // 编辑模式目标（GUI 反馈：新增插件无法编辑）：manifest 插件可改表单覆盖写回。
  const [editPluginId, setEditPluginId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await invokeCommand<PluginListResult>("plugin_list"));
    } catch (err) {
      console.error("Failed to list plugins:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const withBusy = useCallback(
    async (id: string, action: () => Promise<void>) => {
      setBusyIds((prev) => new Set(prev).add(id));
      try {
        await action();
        await refresh();
      } catch (err) {
        void alertDialog({ title: t("plugins.actionFailed"), description: String(err) });
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [alertDialog, refresh, t],
  );

  const handleToggle = useCallback(
    (plugin: PluginDescriptor, enabled: boolean) => {
      void withBusy(plugin.id, async () => {
        await invokeCommand("plugin_set_enabled", {
          pluginId: plugin.id,
          enabled,
        });
      });
    },
    [withBusy],
  );

  const handleRemove = useCallback(
    (plugin: PluginDescriptor) => {
      void (async () => {
        const ok = await confirmDialog({
          title: t("plugins.removeTitle", { name: plugin.display_name }),
          description: t("plugins.removeDesc"),
          confirmText: t("plugins.removeConfirm"),
          variant: "destructive",
        });
        if (!ok) return;
        await withBusy(plugin.id, async () => {
          await invokeCommand("plugin_remove", { pluginId: plugin.id });
        });
      })();
    },
    [confirmDialog, t, withBusy],
  );

  const handleReload = useCallback(async () => {
    setLoading(true);
    try {
      await invokeCommand("plugin_reload");
      await refresh();
    } catch (err) {
      console.error("Failed to reload plugins:", err);
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  /** 需求5：安装（精简版 env-check 流程——提权询问 + install_agent_command）。 */
  const handleInstall = useCallback(
    (plugin: PluginDescriptor, status: AgentStatus) => {
      const command = status.native_install_command || status.install_hint;
      if (!command) return;
      void (async () => {
        setInstallingIds((prev) => new Set(prev).add(plugin.id));
        try {
          let needsElevation = false;
          try {
            needsElevation = await invokeCommand<boolean>(
              "install_command_needs_elevation",
              { command },
            );
          } catch {
            // 查询失败不阻断：按无需提权继续，由安装命令自身给出结果。
          }
          if (needsElevation) {
            const agreed = await confirmDialog({
              title: t("env.elevationTitle"),
              description: t("env.elevationDesc", {
                defaultValue: "安装「{{name}}」需要管理员权限，授权窗口（UAC）中点击「是」完成。",
                name: plugin.display_name,
              }),
              confirmText: t("env.elevationConfirm"),
              cancelText: t("common.cancel", "取消"),
            });
            if (!agreed) return;
          }
          const installResult = await invokeCommand<string>("install_agent_command", {
            command,
          });
          if (installResult && !installResult.includes("[PATH_ADDED]")) {
            void alertDialog({ title: t("env.installSuccess", "安装成功"), description: installResult });
          }
          await refreshHealth();
          await refresh();
        } catch (err) {
          void alertDialog({
            title: t("env.installFailed", "安装失败"),
            description: String(err),
          });
        } finally {
          setInstallingIds((prev) => {
            const next = new Set(prev);
            next.delete(plugin.id);
            return next;
          });
        }
      })();
    },
    [alertDialog, confirmDialog, refresh, refreshHealth, t],
  );

  const tr = (key: string, fallback: string) => (t(key) === key ? fallback : t(key));

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      {dialogNode}
      <PluginCreateDialog
        open={createOpen || !!editPluginId}
        onOpenChange={(open) => {
          if (!open) setEditPluginId(null);
          setCreateOpen(open);
        }}
        onCreated={refresh}
        editPluginId={editPluginId}
      />
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{tr("plugins.title", "插件管理")}</h2>
          <p className="text-xs text-muted-foreground mt-1">{tr("plugins.desc", "")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              setEditPluginId(null);
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            <span className="ml-1.5">{tr("plugins.createTitle", "新建插件")}</span>
          </Button>
          <Button variant="outline" size="sm" onClick={handleReload} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-1.5">{tr("plugins.reload", "重新加载")}</span>
          </Button>
        </div>
      </div>

      {result && result.manifest_errors.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertCircle className="h-4 w-4" />
            {tr("env.manifestErrorsTitle", "自定义智能体配置文件加载失败")}
          </div>
          <ul className="mt-2 space-y-1">
            {result.manifest_errors.map(([file, reason]) => (
              <li key={file} className="text-xs font-mono text-destructive/90 break-all">
                {file}: {reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        {(result?.plugins ?? []).map((plugin) => {
          const busy = busyIds.has(plugin.id);
          const installing = installingIds.has(plugin.id);
          // 需求5：健康状态 join（内置与 manifest 插件的安装检测承接）。
          const status = agents.find((a) => a.id === plugin.id);
          const installed = status?.health?.installed ?? null;
          const cliVersion = status?.health?.version ?? null;
          return (
            <div
              key={plugin.id}
              className="flex items-center gap-3 rounded-md border border-border/60 p-3"
            >
              <AgentLogo agentId={plugin.id} size={28} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate">{plugin.display_name}</span>
                  <Badge variant="secondary" className="text-[10px] px-1.5">
                    {plugin.kind === "builtin"
                      ? tr("plugins.kindBuiltin", "内置")
                      : plugin.kind === "tool"
                        ? tr("plugins.kindTool", "工具")
                        : tr("plugins.kindManifest", "声明式")}
                  </Badge>
                  {plugin.core && (
                    <Badge className="text-[10px] px-1.5">{tr("plugins.coreBadge", "核心引擎")}</Badge>
                  )}
                  {!plugin.enabled && (
                    <Badge variant="outline" className="text-[10px] px-1.5">
                      {tr("plugins.disabledBadge", "已禁用")}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground truncate mt-0.5">
                  {plugin.id}
                  {plugin.version ? ` · ${tr("plugins.pluginVersion", "插件")} v${plugin.version}` : ""}
                  {installed != null && (
                    <span className={installed ? "" : " text-destructive"}>
                      {" · "}
                      {installed
                        ? `${tr("plugins.installed", "已安装")}${cliVersion ? ` v${cliVersion}` : ""}`
                        : tr("plugins.notInstalled", "未安装")}
                    </span>
                  )}
                  {plugin.source_path ? ` · ${plugin.source_path}` : ""}
                </div>
                {!installed && status?.install_hint && (
                  <div className="text-[10px] text-muted-foreground/80 truncate mt-0.5 font-mono">
                    {status.install_hint}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {(busy || installing) && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                {status && !installed && (status.native_install_command || status.install_hint) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || installing}
                    onClick={() => handleInstall(plugin, status)}
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span className="ml-1">{tr("env.install", "安装")}</span>
                  </Button>
                )}
                {(plugin.kind === "manifest" || plugin.kind === "tool") && (
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    aria-label={tr("plugins.edit", "编辑")}
                    onClick={() => {
                      setCreateOpen(false);
                      setEditPluginId(plugin.id);
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
                {(plugin.kind === "manifest" || plugin.kind === "tool") && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    aria-label={tr("plugins.remove", "卸载")}
                    onClick={() => handleRemove(plugin)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
                {plugin.core ? (
                  <span className="text-xs text-muted-foreground w-9 text-center">—</span>
                ) : (
                  <Switch
                    checked={plugin.enabled}
                    disabled={busy}
                    onCheckedChange={(checked) => handleToggle(plugin, checked)}
                    aria-label={tr("plugins.toggle", "启用/禁用")}
                  />
                )}
              </div>
            </div>
          );
        })}
        {result && result.plugins.length === 0 && (
          <p className="text-sm text-muted-foreground py-8 text-center">
            {tr("plugins.empty", "无插件")}
          </p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {tr("plugins.hint", "")}
      </p>
    </div>
  );
}
