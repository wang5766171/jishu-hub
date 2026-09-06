import { useCallback, useEffect, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { AgentLogo, useAgent } from "@/agents";
import { PluginIcon } from "@/components/ui/icon-picker";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { AlertCircle, ChevronDown, Download, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AgentStatus } from "@/agents/types";
import { PluginCreateDialog } from "./plugin-create-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LayoutDashboard } from "lucide-react";

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
  /** v0.9.0 需求1：声明了 [mcp] 段（hub 聚合 MCP server 工具来源）。 */
  has_mcp?: boolean;
  /** v0.9.0 需求20：声明了 [skill] 段（skill 分发服务来源）。 */
  has_skill?: boolean;
  /** v0.9.0 需求19 第三轮：声明了 [pi_extension] 段（自适应/深度形态插件）。 */
  has_pi_extension?: boolean;
  /** info.icon 声明值（v0.9.0 需求19：图标注册表渲染，未知键回退 Bot）。 */
  icon?: string;
  /** v0.9.0 需求8：声明式面板（list 只读模板 MVP）。 */
  has_panel?: boolean;
  panel?: {
    title: string;
    items: Array<{ label: string; command: string }>;
  } | null;
  /** v0.9.0 需求1 二期：系统插件（hub 随包分发、幂等重部署）——不可卸载/
   * 编辑（mcp-resolver / task-requirements / task-plan），可禁用。 */
  system?: boolean;
}

interface PluginListResult {
  plugins: PluginDescriptor[];
  manifest_errors: [string, string][];
}

/** 需求19 第二轮：管理页分类（与创建页类型三分同构 + 核心引擎类）。
 * 核心引擎 = core（jishu-self）+ 解析器系统插件（mcp-resolver；后续
 * skill/CLI 解析器并入此判定）；MCP/CLI 按 kind=tool 的 has_mcp 分流；
 * 智能体 = 内置适配器与 manifest 智能体。 */
type PluginCategory = "core" | "mcp" | "skill" | "cli" | "custom" | "agent";

/** 核心引擎 = core + 解析器 + 预置指南插件（v0.9.0 需求22 并入）。 */
const CORE_ENGINE_PLUGIN_IDS = new Set([
  "mcp-resolver",
  "skill-resolver",
  "jishu-cli-guide",
  "mcp-create-tool",
  "skill-create-tool",
]);

function categoryOf(p: PluginDescriptor): PluginCategory {
  if (p.core || CORE_ENGINE_PLUGIN_IDS.has(p.id)) return "core";
  if (p.kind === "tool") {
    if (p.has_mcp) return "mcp";
    if (p.has_skill) return "skill";
    // 声明式能力插件（需求19 第八轮）：[panel] 管理面板声明（解析器面板
    // 已被核心引擎判定截获）与 [pi_extension] 自适应插件归「自定义插件」。
    if (p.has_panel || p.has_pi_extension) return "custom";
    return "cli";
  }
  // 自建 manifest 智能体单列「自定义插件」（独立插拔），与内置智能体分列。
  if (p.kind === "manifest") return "custom";
  return "agent";
}

const PLUGIN_CATEGORIES: Array<{ key: PluginCategory; labelKey: string; fallback: string }> = [
  { key: "core", labelKey: "plugins.catCore", fallback: "核心引擎" },
  { key: "mcp", labelKey: "plugins.typeMcp", fallback: "MCP 工具" },
  { key: "skill", labelKey: "plugins.typeSkill", fallback: "Skill 工具" },
  { key: "cli", labelKey: "plugins.typeCli", fallback: "CLI 工具" },
  { key: "custom", labelKey: "plugins.catCustom", fallback: "自定义插件" },
  { key: "agent", labelKey: "plugins.typeAgent", fallback: "智能体" },
];

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
  // v0.9.0 需求8：声明式面板 Dialog 状态。
  const [panelTarget, setPanelTarget] = useState<PluginDescriptor | null>(null);
  const [panelOutputs, setPanelOutputs] = useState<Record<number, string>>({});
  const [panelRunning, setPanelRunning] = useState<number | null>(null);
  const runPanelItem = useCallback(async (pluginId: string, index: number) => {
    setPanelRunning(index);
    setPanelOutputs((prev) => ({ ...prev, [index]: "…" }));
    try {
      const r = await invokeCommand<{ label: string; output: string; ok: boolean }>(
        "plugin_panel_run",
        { pluginId, itemIndex: index },
      );
      setPanelOutputs((prev) => ({
        ...prev,
        [index]: `${r.output.trim() || "(无输出)"}${r.ok ? "" : "\n[退出码非零]"}`,
      }));
    } catch (err) {
      setPanelOutputs((prev) => ({ ...prev, [index]: `执行失败：${err}` }));
    } finally {
      setPanelRunning(null);
    }
  }, []);

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

  // 需求20：分类折叠（偏好记忆于 localStorage）。
  const COLLAPSE_KEY = "plugins-cat-collapsed";
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(COLLAPSE_KEY);
      return new Set(saved ? (JSON.parse(saved) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const toggleCategory = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        // 存储不可用时仅本次会话生效
      }
      return next;
    });
  };

  // v0.9.0 需求1 二期：MCP 解析器（mcp-resolver 系统插件）启用态——新建
  // 插件对话框的 MCP 区门控（列表未加载完成前按启用放行，避免首开误锁）。
  const mcpResolverEnabled = result
    ? (result.plugins.find((p) => p.id === "mcp-resolver")?.enabled ?? false)
    : true;
  // 需求20：skill 解析器启用态（新建插件 SKILL 区门控）。
  const skillResolverEnabled = result
    ? (result.plugins.find((p) => p.id === "skill-resolver")?.enabled ?? false)
    : true;


  /** 插件卡片行（需求19 第二轮：分类分组内逐项渲染）。 */
  const renderRow = (plugin: PluginDescriptor) => {
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
            {plugin.kind === 'builtin' ? (
              <AgentLogo agentId={plugin.id} size={28} />
            ) : (
              <PluginIcon icon={plugin.icon} size={28} />
            )}
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
                {plugin.system && (
                  <Badge variant="outline" className="text-[10px] px-1.5">
                    {tr("plugins.systemBadge", "系统")}
                  </Badge>
                )}
                {plugin.has_mcp && (
                  <Badge variant="outline" className="text-[10px] px-1.5">
                    {tr("plugins.mcpBadge", "MCP")}
                  </Badge>
                )}
                {plugin.has_panel && (
                  <button
                    type="button"
                    onClick={() => {
                      setPanelTarget(plugin);
                      setPanelOutputs({});
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-border/70 px-1.5 py-0.5 text-[10px] text-foreground/80 hover:bg-accent/60"
                  >
                    <LayoutDashboard className="h-3 w-3" />
                    {tr("plugins.panelButton", "面板")}
                  </button>
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
              {/* v0.9.0 需求1 二期：系统插件隐藏编辑/卸载（随包分发、启动
               * 幂等重部署——编辑会被覆盖，卸载是无操作）。 */}
              {!plugin.system && (plugin.kind === "manifest" || plugin.kind === "tool") && (
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
              {!plugin.system && (plugin.kind === "manifest" || plugin.kind === "tool") && (
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
  };

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
        mcpResolverEnabled={mcpResolverEnabled}
        skillResolverEnabled={skillResolverEnabled}
      />
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{tr("plugins.title", "插件管理")}</h2>
          <p className="text-xs text-muted-foreground mt-1">{tr("plugins.desc", "")}</p>
          {/* v0.9.0 需求11/12 终版裁决：页外零 MCP 入口——MCP/skills 等一切能力
              经插件机制统一管控（创建走「新建插件」；四家注入由启停/启动自动同步）。 */}
          <p className="text-[11px] text-muted-foreground/70 mt-0.5">
            {tr("plugins.unifiedNote", "MCP、skills、面板等能力统一通过插件机制管理")}
          </p>
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

      <div className="space-y-4">
        {PLUGIN_CATEGORIES.map((cat) => {
          const items = (result?.plugins ?? []).filter((x) => categoryOf(x) === cat.key);
          // v0.9.1 需求9：分类常显——空分类（如 Skill 工具暂无成员）也展示
          // 类型标题与计数 0（用户裁决：skill 即使 0 也要显示），空态一行占位。
          const isCollapsed = collapsed.has(cat.key);
          return (
            <div key={cat.key} className="space-y-2">
              <button
                type="button"
                onClick={() => toggleCategory(cat.key)}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 hover:text-foreground/80 transition-colors"
              >
                <ChevronDown
                  className={cn(
                    "h-3 w-3 transition-transform",
                    isCollapsed && "-rotate-90",
                  )}
                />
                {tr(cat.labelKey, cat.fallback)}
                <span className="text-muted-foreground/50">{items.length}</span>
              </button>
              {!isCollapsed &&
                (items.length > 0 ? (
                  items.map((plugin) => renderRow(plugin))
                ) : (
                  <p className="px-1 py-2 text-xs text-muted-foreground/60">
                    {tr("plugins.categoryEmpty", "暂无插件")}
                  </p>
                ))}
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

      {/* v0.9.0 需求8：声明式面板（list 只读模板）——逐项执行声明命令并展示输出。 */}
      <Dialog open={!!panelTarget} onOpenChange={(open) => { if (!open) setPanelTarget(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{panelTarget?.panel?.title ?? panelTarget?.display_name}</DialogTitle>
            <DialogDescription>
              {tr("plugins.panelDescription", "插件声明的只读命令面板，点击执行查看输出。")}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto">
            {(panelTarget?.panel?.items ?? []).map((item, index) => (
              <div key={index} className="rounded-md border border-border/60 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">{item.label}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={panelRunning !== null}
                    onClick={() => runPanelItem(panelTarget!.id, index)}
                  >
                    {panelRunning === index ? tr("plugins.panelRunning", "执行中…") : tr("plugins.panelRun", "执行")}
                  </Button>
                </div>
                <p className="mt-1 truncate text-[11px] text-muted-foreground" title={item.command}>
                  <code>{item.command}</code>
                </p>
                {panelOutputs[index] && (
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/60 p-2 text-[11px]">
                    {panelOutputs[index]}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
