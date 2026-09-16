import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { AgentLogo, useAgent } from "@/agents";
import { PluginIcon } from "@/components/ui/icon-picker";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { AlertCircle, Download, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AgentStatus } from "@/agents/types";
import { PluginCreateDialog } from "./plugin-create-dialog";
import { PluginDetailModal, type DrawerPluginInfo } from "./plugin-detail-modal";
import { PluginComposeDialog } from "./plugin-compose-dialog";
import { listSessionPlugins } from "@/features/session-kernel/plugins/registry";
import { composedVersion, subscribeComposed } from "@/features/session-kernel/capabilities/composition/loader";
import { Info, Puzzle, Settings2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LayoutDashboard } from "lucide-react";

/** v0.8.1 需求3：插件中心页（v0.9.3 需求11 更名）。数据源 plugin_list（需求2 的统一插件模型），
 * 启停/卸载/重载均热生效（后端重建 registry，无需重启应用）。
 * v0.8.1 需求5：承接原环境检测页的智能体安装检测（未安装展示安装命令与
 * 一键安装；核心引擎仍走环境检测页）。 */
interface PluginDescriptor {
  id: string;
  display_name: string;
  /** v0.9.3 需求11：中文说明（Rust 侧 [tool]/[skill] 首句或内置对照表；
   * session 插件走前端 i18n；null = 无来源，用类型兜底文案）。 */
  description?: string | null;
  kind: "builtin" | "manifest" | "tool" | "session";
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
  /** v0.9.3 需求13：组合式插件（manifest 装配；用户创建的可删除）。 */
  composed?: boolean;
}

interface PluginListResult {
  plugins: PluginDescriptor[];
  manifest_errors: [string, string][];
}

/** 需求19 第二轮：管理页分类（与创建页类型三分同构 + 核心引擎类）。
 * 核心引擎 = core（jishu-self）+ 解析器系统插件（mcp-resolver；后续
 * skill/CLI 解析器并入此判定）；MCP/CLI 按 kind=tool 的 has_mcp 分流；
 * 智能体 = 内置适配器与 manifest 智能体。 */
type PluginCategory = "core" | "session" | "mcp" | "skill" | "cli" | "custom" | "agent";

/** 核心引擎 = core + 解析器 + 预置指南插件（v0.9.0 需求22 并入）。 */
const CORE_ENGINE_PLUGIN_IDS = new Set([
  "mcp-resolver",
  "skill-resolver",
  "jishu-cli-guide",
  "mcp-create-tool",
  "skill-create-tool",
]);

function categoryOf(p: PluginDescriptor): PluginCategory {
  // v0.9.2 需求1：会话能力插件（前端注册表实现，此处统一管理面启停）。
  if (p.kind === "session") return "session";
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

/** v0.9.3 需求11：分类改横向 tab（顺序按用户口径，智能体置首）。 */
const PLUGIN_CATEGORIES: Array<{ key: PluginCategory; labelKey: string; fallback: string }> = [
  { key: "agent", labelKey: "plugins.typeAgent", fallback: "智能体" },
  { key: "core", labelKey: "plugins.catCore", fallback: "核心引擎" },
  { key: "session", labelKey: "plugins.catSession", fallback: "会话能力" },
  { key: "mcp", labelKey: "plugins.typeMcp", fallback: "MCP" },
  { key: "skill", labelKey: "plugins.typeSkill", fallback: "Skill" },
  { key: "cli", labelKey: "plugins.typeCli", fallback: "CLI" },
  { key: "custom", labelKey: "plugins.catCustom", fallback: "自定义" },
];

export function PluginsPage() {
  const { t } = useTranslation();
  const { alert: alertDialog, confirm: confirmDialog, dialogNode } = useConfirmDialog();
  // v0.9.3 需求13：组合清单异步装载完成后重算卡片（⚙ 设置钮/描述依赖前端描述符）。
  useSyncExternalStore(subscribeComposed, composedVersion, () => 0);
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
  // v0.9.3 需求12 P1（交互返工）：卡片显式按钮进入详情/编辑模态
  //（用户裁决：不点卡片弹出；编辑按钮直落设置 tab）。
  const [detailTarget, setDetailTarget] = useState<PluginDescriptor | null>(null);
  // v0.9.3 需求13 C3：新建组合插件向导。
  const [composeOpen, setComposeOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"info" | "settings">("info");
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

  // v0.9.3 需求11：分类改横向 tab（替换需求20 的折叠分区），记忆最后选择。
  const TAB_KEY = "plugins-center-tab";
  const [activeTab, setActiveTab] = useState<PluginCategory>(() => {
    const saved = localStorage.getItem(TAB_KEY);
    return PLUGIN_CATEGORIES.some((c) => c.key === saved) ? (saved as PluginCategory) : "agent";
  });
  const switchTab = (key: PluginCategory) => {
    setActiveTab(key);
    try {
      localStorage.setItem(TAB_KEY, key);
    } catch {
      // 存储不可用时仅本次会话生效
    }
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


  /** v0.9.3 需求11：插件卡片（workbuddy 风格紧凑卡）——图标+名称+开关一行，
   * 徽章与元信息两行内收敛，动作按钮底部一行；网格自适应列数铺满区域。 */
  const renderCard = (plugin: PluginDescriptor) => {
        const busy = busyIds.has(plugin.id);
        const installing = installingIds.has(plugin.id);
        // 需求5：健康状态 join（内置与 manifest 插件的安装检测承接）。
        const status = agents.find((a) => a.id === plugin.id);
        const installed = status?.health?.installed ?? null;
        const cliVersion = status?.health?.version ?? null;
        return (
          <div
            key={plugin.id}
            className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background p-3 transition-colors hover:border-border"
          >
            {/* 首行：图标 + 名称 + 开关（workbuddy 卡头形态）。 */}
            <div className="flex items-center gap-2">
              {plugin.kind === 'builtin' ? (
                <AgentLogo agentId={plugin.id} size={26} />
              ) : (
                <PluginIcon icon={plugin.icon} size={26} />
              )}
              <span
                className="min-w-0 flex-1 truncate text-[13px] font-medium"
                title={plugin.kind === "session"
                  ? tr(`sessionPlugins.${plugin.id.replace("session.", "")}.name`, plugin.display_name)
                  : plugin.display_name}
              >
                {plugin.kind === "session"
                  ? tr(`sessionPlugins.${plugin.id.replace("session.", "")}.name`, plugin.display_name)
                  : plugin.display_name}
              </span>
              {plugin.core ? (
                <span className="text-[10px] text-muted-foreground/60">—</span>
              ) : (
                <Switch
                  checked={plugin.enabled}
                  disabled={busy}
                  onCheckedChange={(checked) => handleToggle(plugin, checked)}
                  aria-label={tr("plugins.toggle", "启用/禁用")}
                />
              )}
            </div>
            {/* 徽章行：状态收敛（禁用显眼、其余轻量；核心引擎类目内不再重复徽章）。 */}
            <div className="flex min-h-[16px] flex-wrap items-center gap-1">
              {!plugin.enabled && !plugin.core && (
                <Badge variant="outline" className="px-1 py-0 text-[9px] text-muted-foreground">
                  {tr("plugins.disabledBadge", "已禁用")}
                </Badge>
              )}
              {plugin.kind === "builtin" || plugin.kind === "session" ? (
                <Badge variant="secondary" className="px-1 py-0 text-[9px]">
                  {tr("plugins.kindBuiltin", "内置")}
                </Badge>
              ) : plugin.kind === "tool" ? (
                <Badge variant="secondary" className="px-1 py-0 text-[9px]">
                  {tr("plugins.kindTool", "工具")}
                </Badge>
              ) : (
                <Badge variant="secondary" className="px-1 py-0 text-[9px]">
                  {tr("plugins.kindManifest", "声明式")}
                </Badge>
              )}
              {plugin.system && (
                <Badge variant="outline" className="px-1 py-0 text-[9px]">
                  {tr("plugins.systemBadge", "系统")}
                </Badge>
              )}
              {plugin.has_mcp && (
                <Badge variant="outline" className="px-1 py-0 text-[9px]">
                  {tr("plugins.mcpBadge", "MCP")}
                </Badge>
              )}
            </div>
            {/* 说明（v0.9.3 需求11 用户裁决：中文说明取代 id/版本显示；编码与
             * 版本等运维信息收进 title 悬停）。来源链：session → i18n →
             * Rust description（[tool]/[skill] 首句或内置对照表）→ 类型兜底。 */}
            <div
              className="line-clamp-2 min-h-[26px] text-[10px] leading-[13px] text-muted-foreground/80"
              title={[
                plugin.id,
                plugin.version ? `v${plugin.version}` : "",
                installed != null
                  ? installed
                    ? `${tr("plugins.installed", "已安装")}${cliVersion ? ` v${cliVersion}` : ""}`
                    : tr("plugins.notInstalled", "未安装")
                  : "",
                plugin.source_path ?? "",
                !installed && status?.install_hint ? status.install_hint : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              {plugin.kind === "session"
                ? tr(`sessionPlugins.${plugin.id.replace("session.", "")}.description`, plugin.display_name)
                : plugin.description
                  || tr(
                      plugin.kind === "builtin"
                        ? "plugins.descFallbackBuiltin"
                        : plugin.kind === "manifest"
                          ? "plugins.descFallbackManifest"
                          : "plugins.descFallbackTool",
                      plugin.kind === "builtin"
                        ? "内置智能体适配器"
                        : plugin.kind === "manifest"
                          ? "manifest 声明的自定义智能体"
                          : "自定义能力插件",
                    )}
            </div>
            {/* 动作行：安装 / 面板 / 详情 / 编辑 / 卸载 / 加载中。v0.9.3
                需求12 返工：详情（全插件）与设置编辑（有配置面的会话插件）
                图标钮直达模态。 */}
            <div className="mt-auto flex items-center gap-1 pt-0.5">
              {(busy || installing) && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              {status && !installed && (status.native_install_command || status.install_hint) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  disabled={busy || installing}
                  onClick={() => handleInstall(plugin, status)}
                >
                  <Download className="h-3 w-3" />
                  <span className="ml-0.5">{tr("env.install", "安装")}</span>
                </Button>
              )}
              {plugin.has_panel && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() => {
                    setPanelTarget(plugin);
                    setPanelOutputs({});
                  }}
                >
                  <LayoutDashboard className="h-3 w-3" />
                  <span className="ml-0.5">{tr("plugins.panelButton", "面板")}</span>
                </Button>
              )}
              <span className="flex-1" />
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={tr("plugins.viewDetails", "详情")}
                title={tr("plugins.viewDetails", "详情")}
                onClick={() => {
                  setDetailTab("info");
                  setDetailTarget(plugin);
                }}
              >
                <Info className="h-3 w-3" />
              </Button>
              {plugin.kind === "session" &&
                listSessionPlugins().find((p) => p.id === plugin.id)?.configSchema && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    aria-label={tr("plugins.editSettings", "设置")}
                    title={tr("plugins.editSettings", "设置")}
                    onClick={() => {
                      setDetailTab("settings");
                      setDetailTarget(plugin);
                    }}
                  >
                    <Settings2 className="h-3 w-3" />
                  </Button>
                )}
              {/* v0.9.0 需求1 二期：系统插件隐藏编辑/卸载（随包分发、启动
               * 幂等重部署——编辑会被覆盖，卸载是无操作）。 */}
              {!plugin.system && (plugin.kind === "manifest" || plugin.kind === "tool") && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={busy}
                  aria-label={tr("plugins.edit", "编辑")}
                  onClick={() => {
                    setCreateOpen(false);
                    setEditPluginId(plugin.id);
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
              {(plugin.composed && !plugin.system) || (!plugin.system && (plugin.kind === "manifest" || plugin.kind === "tool")) ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive hover:text-destructive"
                  disabled={busy}
                  aria-label={tr("plugins.remove", "卸载")}
                  onClick={() => {
                    if (plugin.composed) {
                      void (async () => {
                        try {
                          await invokeCommand("composed_plugin_delete", { id: plugin.id });
                          await refresh();
                        } catch (e) {
                          console.warn("composed_plugin_delete failed:", e);
                        }
                      })();
                      return;
                    }
                    handleRemove(plugin);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              ) : null}
            </div>
          </div>
        );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      {dialogNode}
      <PluginComposeDialog open={composeOpen} onOpenChange={setComposeOpen} onCreated={refresh} />
      {detailTarget ? (
        <PluginDetailModal
          plugin={detailTarget satisfies DrawerPluginInfo as DrawerPluginInfo}
          initialTab={detailTab}
          onClose={() => setDetailTarget(null)}
        />
      ) : null}
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
          <h2 className="text-lg font-semibold">{tr("plugins.title", "插件中心")}</h2>
          <p className="text-xs text-muted-foreground mt-1">{tr("plugins.desc", "")}</p>
          {/* v0.9.0 需求11/12 终版裁决：页外零 MCP 入口——MCP/skills 等一切能力
              经插件机制统一管控（创建走「新建插件」；四家注入由启停/启动自动同步）。 */}
          <p className="text-[11px] text-muted-foreground/70 mt-0.5">
            {tr("plugins.unifiedNote", "MCP、skills、面板等能力统一通过插件机制管理")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setComposeOpen(true)}
            title="零代码组合基座能力（源×渲染组件×动作×配置）生成插件"
          >
            <Puzzle className="h-4 w-4" />
            <span className="ml-1.5">新建组合插件</span>
          </Button>
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

      {/* v0.9.3 需求11：分类横向 tab（胶囊形态，workbuddy 风格）——切换
          不同类型卡片的展示；tab 计数常显（空分类也可见，承需求9 裁决）。 */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/40 pb-3">
        {PLUGIN_CATEGORIES.map((cat) => {
          const items = (result?.plugins ?? []).filter((x) => categoryOf(x) === cat.key);
          const active = activeTab === cat.key;
          return (
            <button
              key={cat.key}
              type="button"
              onClick={() => switchTab(cat.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {tr(cat.labelKey, cat.fallback)}
              <span className={cn("text-[10px] tabular-nums", active ? "opacity-80" : "opacity-50")}>
                {items.length}
              </span>
            </button>
          );
        })}
      </div>

      {/* 卡片网格：自适应列数铺满区域（v0.9.3 需求11，minmax 卡宽 ~230px）。 */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
        {(result?.plugins ?? [])
          .filter((x) => categoryOf(x) === activeTab)
          .map((plugin) => renderCard(plugin))}
      </div>
      {(result?.plugins ?? []).filter((x) => categoryOf(x) === activeTab).length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {result && result.plugins.length === 0
            ? tr("plugins.empty", "无插件")
            : tr("plugins.categoryEmpty", "暂无插件")}
        </p>
      )}

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
