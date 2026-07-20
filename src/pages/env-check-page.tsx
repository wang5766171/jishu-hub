import { useEffect, useState, useCallback } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { AgentLogo, RuntimeLogo, useAgent } from "@/agents";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  ChevronDown,
  ArrowUpCircle,
  Puzzle,
  Cable,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import type { AgentStatus } from "@/agents/types";
import { isVersionNewer, MIN_NODE_VERSION, nodeVersionSatisfies } from "@/agents/version-constants";

interface EnvData {
  node_installed: boolean;
  node_version: string | null;
  npm_installed: boolean;
  npm_version: string | null;
  python_installed: boolean;
  python_version: string | null;
  git_installed: boolean;
  git_version: string | null;
  runtimes?: RuntimeStatus[];
}

interface RuntimeStatus {
  id: string;
  installed: boolean;
  version: string | null;
  install_command?: string | null;
  update_command?: string | null;
  download_url?: string | null;
  latest_package?: string | null;
}

interface CheckItem {
  id: string;
  name: string;
  desc: string;
  installed: boolean;
  version: string | null;
  icon: React.ReactNode;
  iconClassName?: string;
  installCommand?: string;
  updateCommand?: string;
  availableVersion?: string;
  downloadUrl?: string;
  npmPackage?: string;
  /** Original agent ID for MCP status lookup (only for agent items). */
  agentId?: string;
  /** 若设置，安装按钮禁用并显示该原因（如 Node 版本过低）。 */
  installBlockedReason?: string;
}

interface LatestVersion {
  id: string;
  latest_version: string | null;
  error: string | null;
}

interface AdapterVersionStatus {
  installed: boolean;
  version: string | null;
}

function VersionBadge({ version }: { version: string | null }) {
  if (!version) return null;
  const v = version.startsWith("v") ? version : `v${version}`;
  return (
    <span className="text-xs font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
      {v}
    </span>
  );
}

function UpdateBadge({ latest }: { latest: string }) {
  return (
    <span className="text-xs font-mono text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded flex items-center gap-1">
      <ArrowUpCircle className="h-3 w-3" />
      v{latest}
    </span>
  );
}

function StatusIndicator({
  installed,
  hasUpdate,
  labelNormal,
  labelNotInstalled,
}: {
  installed: boolean;
  hasUpdate: boolean;
  labelNormal: string;
  labelNotInstalled: string;
}) {
  if (!installed) {
    return (
      <div className="flex items-center gap-1 text-destructive shrink-0 min-w-[60px] justify-end">
        <XCircle className="h-4 w-4" />
        <span className="text-xs font-medium">{labelNotInstalled}</span>
      </div>
    );
  }
  if (hasUpdate) {
    return (
      <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400 shrink-0 min-w-[60px] justify-start">
        <ArrowUpCircle className="h-4 w-4" />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 text-[var(--icon-success)] shrink-0 min-w-[60px] justify-start">
      <CheckCircle2 className="h-4 w-4" />
      <span className="text-xs font-medium">{labelNormal}</span>
    </div>
  );
}

export function EnvCheckPage({ onComplete }: { onComplete?: () => void }) {
  const { t } = useTranslation();
  const { alert: alertDialog, dialogNode: confirmDialogNode } = useConfirmDialog();
  const [env, setEnv] = useState<EnvData | null>(null);
  const { agents, refreshHealth, healthLoading } = useAgent();
  // Tracks every item currently being installed/updated concurrently.
  // A single id would let the second click clobber the first's spinner,
  // making it look like only one update can run at a time.
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());
  const [expandedAgents, setExpandedAgents] = useState(false);
  const [checking, setChecking] = useState(false);
  const [latestVersions, setLatestVersions] = useState<Map<string, string>>(
    new Map()
  );
  const [installingMcpId, setInstallingMcpId] = useState<string | null>(null);
  const [installingBridgeId, setInstallingBridgeId] = useState<string | null>(
    null
  );

  const [cliInstalled, setCliInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    invokeCommand<EnvData>("check_environment")
      .then(setEnv)
      .catch(console.error);
    invokeCommand<boolean>("check_cli_symlink")
      .then(setCliInstalled)
      .catch(console.error);
  }, []);

  const runtimeMeta: Record<
    string,
    { name: string; desc: string; icon: React.ReactNode; iconClassName?: string }
  > = {
    node: {
      name: t("env.nodeTitle"),
      desc: t("env.nodeDesc"),
      icon: <RuntimeLogo runtimeId="node" size={18} />,
      iconClassName: "bg-transparent",
    },
    npm: {
      name: t("env.npmTitle"),
      desc: t("env.npmDesc"),
      icon: <RuntimeLogo runtimeId="npm" size={18} />,
      iconClassName: "bg-transparent",
    },
    python: {
      name: t("env.pythonTitle"),
      desc: t("env.pythonDesc"),
      icon: <RuntimeLogo runtimeId="python" size={18} />,
      iconClassName: "bg-transparent",
    },
    git: {
      name: t("env.gitTitle"),
      desc: t("env.gitDesc"),
      icon: <RuntimeLogo runtimeId="git" size={18} />,
      iconClassName: "bg-transparent",
    },
  };

  const fallbackRuntimes: RuntimeStatus[] = env
    ? [
        {
          id: "node",
          installed: env.node_installed,
          version: env.node_version,
          download_url: "https://nodejs.org/",
          latest_package: "node",
        },
        {
          id: "npm",
          installed: env.npm_installed,
          version: env.npm_version,
          update_command: "npm install -g npm@latest",
          latest_package: "npm",
        },
        {
          id: "python",
          installed: env.python_installed,
          version: env.python_version,
          download_url: "https://www.python.org/downloads/",
          latest_package: "python",
        },
        {
          id: "git",
          installed: env.git_installed,
          version: env.git_version,
          download_url: "https://git-scm.com/downloads",
          latest_package: "git",
        },
      ]
    : [];

  const runtimeItems: CheckItem[] = env
    ? (env.runtimes?.length ? env.runtimes : fallbackRuntimes).map((runtime) => {
        const meta = runtimeMeta[runtime.id] ?? {
          name: runtime.id,
          desc: "",
          icon: <RuntimeLogo runtimeId={runtime.id} size={18} />,
          iconClassName: "bg-transparent",
        };
        return {
          id: runtime.id,
          name: meta.name,
          desc: meta.desc,
          installed: runtime.installed,
          version: runtime.version,
          icon: meta.icon,
          iconClassName: meta.iconClassName,
          installCommand: runtime.install_command ?? undefined,
          updateCommand: runtime.update_command ?? undefined,
          downloadUrl: runtime.download_url ?? undefined,
          npmPackage: runtime.latest_package ?? undefined,
        };
      })
    : [];

  const sortedAgents = [...agents].sort((a, b) => {
    if (a.id === "jishu-self") return -1;
    if (b.id === "jishu-self") return 1;
    return 0;
  });

  const agentItems: CheckItem[] = sortedAgents.map((agent) => {
    let desc = agent.install_hint?.replace("npm install -g ", "") || "";
    let installBlockedReason: string | undefined;
    if (agent.id === "jishu-self") {
      desc = t("env.jishuAgentImportance", "Jishu Agent 是本应用的核心智能体引擎。安装它能解锁完整的文件系统操作、原生命令行执行以及强大的 MCP 服务支持，强烈建议安装。");
      if (
        env?.node_version &&
        !nodeVersionSatisfies(env.node_version, MIN_NODE_VERSION)
      ) {
        installBlockedReason = t(
          "env.nodeVersionTooLowShort",
          `Node 版本过低 v${env.node_version}（需 ≥ v${MIN_NODE_VERSION}）`,
        );
      }
    }
    
    return {
      id: `agent-${agent.id}`,
      name: agent.display_name,
      desc,
      installed: agent.health.installed,
      version: agent.health.version,
      icon: <AgentLogo agentId={agent.id} size={18} />,
      iconClassName: "bg-transparent",
      updateCommand: agent.native_install_command || agent.install_hint || undefined,
      installCommand: agent.native_install_command || agent.install_hint || undefined,
      availableVersion: agent.available_version ?? undefined,
      npmPackage: agent.install_hint
        ?.replace("npm install -g ", "")
        ?.trim(),
      agentId: agent.id,
      installBlockedReason,
    };
  });

  const hasUpdate = useCallback(
    (item: CheckItem): boolean => {
      if (!item.installed || !item.version) return false;
      const latest = latestVersions.get(item.id);
      return latest ? isVersionNewer(item.version, latest) : false;
    },
    [latestVersions]
  );

  const openUrl = (url: string) => {
    invokeCommand("open_url", { url }).catch(console.error);
  };

  const handleInstall = async (item: CheckItem) => {
    // jishu-self 安装前校验 Node.js 版本（pi 要求 >=22.19），过低直接提示升级、不执行安装。
    if (
      item.agentId === "jishu-self" &&
      env?.node_version &&
      !nodeVersionSatisfies(env.node_version, MIN_NODE_VERSION)
    ) {
      await alertDialog({
        title: t("env.title", "环境检测"),
        description: t(
          "env.nodeVersionTooLow",
          `Node.js 版本过低（当前 v${env.node_version}，Jishu Agent 需要 Node.js ≥ v${MIN_NODE_VERSION}），请升级 Node.js 后重试。`,
        ),
      });
      return;
    }
    const command = item.installed
      ? item.updateCommand
      : item.installCommand ?? item.updateCommand;
    if (!command) return;
    setInstallingIds((prev) => new Set(prev).add(item.id));
    try {
      await invokeCommand("install_agent_command", {
        command,
      });
      if (item.id.startsWith("agent-")) {
        await refreshHealth({ silent: true });
        if (item.availableVersion && item.installed) {
          const statuses = await invokeCommand<AgentStatus[]>("agent_list_statuses");
          const actualVersion = statuses.find((status) => status.id === item.agentId)?.health.version;
          if (!actualVersion || isVersionNewer(actualVersion, item.availableVersion)) {
            throw new Error(
              t("env.updateVersionMismatch", {
                current: actualVersion ?? t("common.unknown", "未知"),
                target: item.availableVersion,
                defaultValue: "更新完成后检测到的版本仍为 {{current}}，目标版本为 {{target}}",
              }),
            );
          }
        }
        setLatestVersions((current) => {
          const next = new Map(current);
          next.delete(item.id);
          return next;
        });
        if (item.availableVersion && item.installed) {
          await alertDialog({
            title: t("env.updateSuccess", "更新成功"),
            description: t(
              "env.jishuAgentRestartRequired",
              "Jishu Agent 已更新。请重启 Jishu Hub，以结束旧运行时进程并让新会话使用最新版本。",
            ),
          });
        }
      } else {
        const newEnv = await invokeCommand<EnvData>("check_environment");
        setEnv(newEnv);
      }
    } catch (err) {
      console.error(err);
      // Backend may surface an empty detail when npm/winget fail; never
      // show a bare "安装失败:" with no reason.
      const reason = String(err).trim() || t("env.installFailedUnknown", "未知错误，请查看控制台日志");
      await alertDialog({ title: t("env.title", "环境检测"), description: `安装失败: ${reason}` });
    } finally {
      setInstallingIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const handleRefresh = async () => {
    setChecking(true);
    try {
      const newEnv = await invokeCommand<EnvData>("check_environment");
      setEnv(newEnv);
      // Silent: the "check updates" button has its own spinner (checking
      // state). No reason to flip the whole page back to the loading view.
      await refreshHealth({ silent: true });

      const packages: [string, string][] = [];
      const currentAgents = await invokeCommand<AgentStatus[]>(
        "agent_list_statuses"
      );

      for (const item of [...runtimeItems, ...agentItems]) {
        if (item.npmPackage) {
          packages.push([item.id, item.npmPackage]);
        }
      }
      for (const agent of currentAgents || []) {
        const agentItemId = `agent-${agent.id}`;
        if (agent.install_hint) {
          const pkg = agent.install_hint
            .replace("npm install -g ", "")
            .trim();
          if (pkg) {
            if (!packages.some((p) => p[0] === agentItemId)) {
              packages.push([agentItemId, pkg]);
            }
          }
        }
        if (agent.mcp_installed) {
          packages.push([`mcp-${agent.id}`, "pi-mcp-adapter"]);
        }
      }

      if (packages.length > 0) {
        const results = await invokeCommand<LatestVersion[]>(
          "check_available_updates",
          { packages }
        );
        if (results) {
          const map = new Map<string, string>();
          for (const agent of currentAgents || []) {
            if (agent.available_version) {
              map.set(`agent-${agent.id}`, agent.available_version);
            }
          }
          for (const r of results) {
            if (r.latest_version) {
              map.set(r.id, r.latest_version);
            }
          }
          setLatestVersions(map);
        }
      }
    } finally {
      setChecking(false);
    }
  };

  // Keep the loading view up until every probe has settled: runtime env, the
  // CLI symlink check, and the agent health refresh. Showing partial data
  // (e.g. before health comes back) looks like the page stalled.
  const initialLoading = !env || cliInstalled === null || healthLoading;
  if (initialLoading) {
    return (
      <div className="p-6 max-w-2xl mx-auto flex flex-col items-center justify-center gap-3 h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("env.checking")}</p>
      </div>
    );
  }

  const visibleAgents = expandedAgents ? agentItems : agentItems.slice(0, 3);

  const rowLabels = {
    labelInstall: t("env.install"),
    labelUpdateBtn: t("env.updateLabel"),
    labelDownload: t("env.download"),
    labelNormal: t("env.normal"),
    labelNotInstalled: t("env.notInstalled"),
  };

  return (
    <div className="p-6 max-w-2xl mx-auto flex flex-col h-full overflow-y-auto">
      {confirmDialogNode}
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">{t("env.title")}</h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={checking}
          className="text-muted-foreground"
        >
          <RefreshCw
            className={`h-4 w-4 mr-1 ${checking ? "animate-spin" : ""}`}
          />
          {checking ? t("env.checkingUpdate") : t("env.checkUpdate")}
        </Button>
      </div>
      <p className="text-muted-foreground mb-5 text-sm">{t("env.desc")}</p>

      <div className="space-y-5 flex-1">
        {cliInstalled === false && (
          <div className="p-3 border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 rounded-lg flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-amber-800 dark:text-amber-200">
                {t("env.cliNotInstalled", "未安装命令行工具")}
              </h3>
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                {t("env.cliDesc", "为了在外部终端中便捷唤起 Jishu Hub，强烈建议安装 jishu 命令 (需授权)。")}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 ml-4 border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/50"
              onClick={async () => {
                try {
                  await invokeCommand("install_cli_symlink");
                  setCliInstalled(true);
                } catch (e) {
                  void alertDialog({ title: t("env.title", "环境检测"), description: `安装失败:\n${String(e)}` });
                }
              }}
            >
              {t("env.install", "安装")}
            </Button>
          </div>
        )}

        {/* Runtime section */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            {t("env.runtimeTitle")}
          </h2>
          <div className="space-y-2">
            {runtimeItems.map((item) => {
              const downloadUrl = item.downloadUrl;
              return (
                <CheckItemRow
                  key={item.id}
                  item={item}
                  installing={installingIds.has(item.id)}
                  onInstall={() => handleInstall(item)}
                  onDownload={downloadUrl ? () => openUrl(downloadUrl) : undefined}
                  hasUpdate={hasUpdate(item)}
                  latestVersion={latestVersions.get(item.id)}
                  {...rowLabels}
                />
              );
            })}
          </div>
        </div>

        {/* Agent CLI section */}
        <div>
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-1">
              {t("env.agentsTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("env.agentsDesc")}
            </p>
          </div>
          <div className="space-y-2">
            {visibleAgents.map((item) => {
              const downloadUrl = item.downloadUrl;
              // Resolve MCP support from adapter's config_surface (no agent_id hardcode).
              const originalAgent = item.agentId
                ? agents.find((a) => a.id === item.agentId)
                : undefined;
              const supportsMcp =
                originalAgent?.config_surface?.kind === "model_store" &&
                (originalAgent.config_surface as { supports_mcp?: boolean }).supports_mcp;
              const mcpInstalled = originalAgent?.mcp_installed ?? false;
              const mcpVersion = originalAgent?.mcp_version ?? null;
              const mcpLatestVersion = item.agentId
                ? latestVersions.get(`mcp-${item.agentId}`)
                : undefined;
              const mcpHasUpdate = Boolean(
                mcpVersion && mcpLatestVersion && isVersionNewer(mcpVersion, mcpLatestVersion),
              );
              return (
                <div key={item.id}>
                  <CheckItemRow
                    item={item}
                    installing={installingIds.has(item.id)}
                    onInstall={() => handleInstall(item)}
                    onDownload={downloadUrl ? () => openUrl(downloadUrl) : undefined}
                    hasUpdate={hasUpdate(item)}
                    latestVersion={item.availableVersion ?? latestVersions.get(item.id)}
                    {...rowLabels}
                  />
                  {/* MCP adapter sub-item — shown only when adapter declares supports_mcp */}
                  {supportsMcp && item.installed && (
                    <div className="ml-9 mt-1.5 flex items-start gap-2.5 py-1.5 px-1">
                      <Puzzle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium leading-tight">
                            MCP {t("env.adapter", "适配器")}
                          </span>
                          {mcpVersion && (
                            <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1 py-0.5 rounded">
                              v{mcpVersion}
                            </span>
                          )}
                          {mcpHasUpdate && mcpLatestVersion && (
                            <UpdateBadge latest={mcpLatestVersion} />
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground leading-tight mt-0.5 truncate">
                          {t("env.mcpDesc", "为 Jishu Agent 提供 MCP 服务调用能力（Web 搜索、网页读取等）")}
                        </p>
                        {mcpInstalled ? (
                          <div className="mt-1 flex items-center gap-2 justify-start">
                            <div className={mcpHasUpdate
                              ? "flex items-center gap-1 text-amber-600 dark:text-amber-400"
                              : "flex items-center gap-1 text-[var(--icon-success)]"
                            }>
                              {mcpHasUpdate
                                ? <ArrowUpCircle className="h-3 w-3" />
                                : <CheckCircle2 className="h-3 w-3" />}
                              <span className="text-[10px] font-medium">
                                {mcpHasUpdate ? t("env.updateLabel", "更新") : t("env.normal", "已就绪")}
                              </span>
                            </div>
                            {mcpHasUpdate && item.agentId && (
                              installingMcpId === item.agentId ? (
                                <Button size="sm" variant="outline" disabled className="h-6 px-2 text-[10px]">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2 text-[10px]"
                                  onClick={async () => {
                                    setInstallingMcpId(item.agentId!);
                                    try {
                                      await invokeCommand("update_mcp_adapter", { agentId: item.agentId });
                                      const status = await invokeCommand<AdapterVersionStatus>(
                                        "check_mcp_adapter",
                                        { agentId: item.agentId },
                                      );
                                      if (
                                        !status.version
                                        || (mcpLatestVersion && isVersionNewer(status.version, mcpLatestVersion))
                                      ) {
                                        throw new Error(
                                          t("env.updateVersionMismatch", {
                                            current: status.version ?? t("common.unknown", "未知"),
                                            target: mcpLatestVersion ?? t("common.unknown", "未知"),
                                            defaultValue: "更新完成后检测到的版本仍为 {{current}}，目标版本为 {{target}}",
                                          }),
                                        );
                                      }
                                      await refreshHealth({ silent: true });
                                      setLatestVersions((current) => {
                                        const next = new Map(current);
                                        next.delete(`mcp-${item.agentId}`);
                                        return next;
                                      });
                                    } catch (err) {
                                      console.error(err);
                                      await alertDialog({ title: t("env.title", "环境检测"), description: `MCP ${t("env.updateFailed", "更新失败")}: ${String(err)}` });
                                    } finally {
                                      setInstallingMcpId(null);
                                    }
                                  }}
                                >
                                  {t("env.updateLabel", "更新")}
                                </Button>
                              )
                            )}
                          </div>
                        ) : (
                          <div className="mt-1 flex items-center gap-1.5 justify-start">
                            <span className="text-[10px] font-medium text-destructive">
                              {t("env.notInstalled", "未安装")}
                            </span>
                            {installingMcpId === item.agentId ? (
                              <Button size="sm" variant="outline" disabled className="h-6 px-2 text-[10px]">
                                <Loader2 className="h-3 w-3 animate-spin" />
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-[10px]"
                                onClick={async () => {
                                  if (!item.agentId) return;
                                  setInstallingMcpId(item.agentId);
                                  try {
                                    await invokeCommand("install_mcp_adapter", { agentId: item.agentId });
                                    await refreshHealth({ silent: true });
                                  } catch (err) {
                                    console.error(err);
                                    await alertDialog({ title: t("env.title", "环境检测"), description: `MCP ${t("env.installFailed", "安装失败")}: ${String(err)}` });
                                  } finally {
                                    setInstallingMcpId(null);
                                  }
                                }}
                              >
                                {t("env.install", "安装")}
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {/* Transport-bridge sub-item — shown when adapter declares supports_transport_bridge */}
                  {originalAgent?.transport_bridge?.supported && item.installed && (
                    <div className="ml-9 mt-1.5 flex items-start gap-2.5 py-1.5 px-1">
                      <Cable className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium leading-tight">
                            {originalAgent.transport_bridge.name ?? "claude-agent-acp"}{" "}
                            {t("env.bridge", "桥")}
                          </span>
                          {originalAgent.transport_bridge.version && (
                            <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1 py-0.5 rounded">
                              v{originalAgent.transport_bridge.version}
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground leading-tight mt-0.5 truncate">
                          {t("env.bridgeDesc", "claude_code 借此桥以 ACP 协议运行，启用会话中途的结构化提问；缺失将降级为命令行模式")}
                        </p>
                        {originalAgent.transport_bridge.installed ? (
                          <div className="mt-1 flex items-center gap-1 text-[var(--icon-success)] justify-start">
                            <CheckCircle2 className="h-3 w-3" />
                            <span className="text-[10px] font-medium">{t("env.normal", "已就绪")}</span>
                          </div>
                        ) : (
                          <div className="mt-1 flex items-center gap-1.5 justify-start">
                            <span className="text-[10px] font-medium text-destructive">
                              {t("env.notInstalled", "未安装")}
                            </span>
                            {installingBridgeId === item.agentId ? (
                              <Button size="sm" variant="outline" disabled className="h-6 px-2 text-[10px]">
                                <Loader2 className="h-3 w-3 animate-spin" />
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-[10px]"
                                onClick={async () => {
                                  if (!item.agentId) return;
                                  setInstallingBridgeId(item.agentId);
                                  try {
                                    await invokeCommand("install_transport_bridge", { agentId: item.agentId });
                                    await refreshHealth({ silent: true });
                                  } catch (err) {
                                    console.error(err);
                                    await alertDialog({ title: t("env.title", "环境检测"), description: `${t("env.bridge", "桥")} ${t("env.installFailed", "安装失败")}: ${String(err)}` });
                                  } finally {
                                    setInstallingBridgeId(null);
                                  }
                                }}
                              >
                                {t("env.install", "安装")}
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {agentItems.length > 3 && !expandedAgents && (
              <button
                onClick={() => setExpandedAgents(true)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mx-auto pt-1"
              >
                <ChevronDown className="h-3 w-3" />
                {t("env.selectModule")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Bottom action */}
      <div className="mt-6 shrink-0">
        {onComplete && (
          <Button className="w-full" size="lg" onClick={onComplete}>
            {t("env.enterWorkspace")}
          </Button>
        )}
      </div>
    </div>
  );
}

function CheckItemRow({
  item,
  installing,
  onInstall,
  onDownload,
  hasUpdate,
  latestVersion,
  labelInstall,
  labelUpdateBtn,
  labelDownload,
  labelNormal,
  labelNotInstalled,
}: {
  item: CheckItem;
  installing: boolean;
  onInstall: () => void;
  onDownload?: () => void;
  hasUpdate: boolean;
  latestVersion?: string;
  labelInstall: string;
  labelUpdateBtn: string;
  labelDownload: string;
  labelNormal: string;
  labelNotInstalled: string;
}) {
  const showUpdateBtn = item.installed && hasUpdate && item.updateCommand;
  const showDownloadUpdateBtn =
    item.installed && hasUpdate && !item.updateCommand && onDownload;
  const showInstallBtn = !item.installed && (item.installCommand || item.updateCommand);
  const showDownloadBtn = !item.installed && !(item.installCommand || item.updateCommand) && onDownload;

  return (
    <div className="flex items-center gap-3 p-3 border rounded-lg bg-card transition-colors">
      <div
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
          item.iconClassName ?? (
            item.installed
              ? hasUpdate
                ? "text-amber-600 dark:text-amber-400"
                : "text-[var(--icon-success)]"
              : "text-muted-foreground"
          )
        }`}
      >
        {item.icon}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{item.name}</span>
          <VersionBadge version={item.version} />
          {hasUpdate && latestVersion && (
            <UpdateBadge latest={latestVersion} />
          )}
          {item.installBlockedReason && (
            <span className="text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded-full whitespace-nowrap">
              {item.installBlockedReason}
            </span>
          )}
        </div>
        {item.desc && (
          <p className="text-xs text-muted-foreground truncate" title={item.desc}>{item.desc}</p>
        )}
      </div>

      <StatusIndicator
        installed={item.installed}
        hasUpdate={hasUpdate}
        labelNormal={labelNormal}
        labelNotInstalled={labelNotInstalled}
      />

      {(showUpdateBtn ||
        showDownloadUpdateBtn ||
        showInstallBtn ||
        showDownloadBtn) && (
        <div className="shrink-0">
          {installing ? (
            <Button size="sm" variant="outline" disabled>
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            </Button>
          ) : showUpdateBtn ? (
            <Button size="sm" variant="outline" onClick={onInstall}>
              {labelUpdateBtn}
            </Button>
          ) : showDownloadUpdateBtn ? (
            <Button size="sm" variant="outline" onClick={onDownload!}>
              {labelUpdateBtn}
            </Button>
          ) : showInstallBtn ? (
            <Button size="sm" variant="outline" onClick={onInstall} disabled={!!item.installBlockedReason}>
              {labelInstall}
            </Button>
          ) : showDownloadBtn ? (
            <Button size="sm" variant="outline" onClick={onDownload!}>
              {labelDownload}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
