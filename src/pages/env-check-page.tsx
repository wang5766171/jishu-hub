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
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentStatus } from "@/agents/types";

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
  downloadUrl?: string;
  npmPackage?: string;
}

interface LatestVersion {
  id: string;
  latest_version: string | null;
  error: string | null;
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
      <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400 shrink-0 min-w-[60px] justify-end">
        <ArrowUpCircle className="h-4 w-4" />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 text-[var(--icon-success)] shrink-0 min-w-[60px] justify-end">
      <CheckCircle2 className="h-4 w-4" />
      <span className="text-xs font-medium">{labelNormal}</span>
    </div>
  );
}

export function EnvCheckPage({ onComplete }: { onComplete?: () => void }) {
  const { t } = useTranslation();
  const [env, setEnv] = useState<EnvData | null>(null);
  const { agents, refreshHealth } = useAgent();
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [expandedAgents, setExpandedAgents] = useState(false);
  const [checking, setChecking] = useState(false);
  const [latestVersions, setLatestVersions] = useState<Map<string, string>>(
    new Map()
  );

  useEffect(() => {
    invokeCommand<EnvData>("check_environment")
      .then(setEnv)
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
          download_url: "https://git-scm.com/downloads/win",
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

  const agentItems: CheckItem[] = agents.map((agent) => ({
    id: `agent-${agent.id}`,
    name: agent.display_name,
    desc: agent.install_hint
      ? agent.install_hint.replace("npm install -g ", "")
      : "",
    installed: agent.health.installed,
    version: agent.health.version,
    icon: <AgentLogo agentId={agent.id} size={18} />,
    iconClassName: "bg-transparent",
    updateCommand: agent.install_hint || undefined,
    npmPackage: agent.install_hint
      ?.replace("npm install -g ", "")
      ?.trim(),
  }));

  const hasUpdate = useCallback(
    (item: CheckItem): boolean => {
      if (!item.installed || !item.version || !latestVersions.has(item.id))
        return false;
      const latest = latestVersions.get(item.id)!;
      const current = item.version.replace(/^v/, "");
      return latest !== current;
    },
    [latestVersions]
  );

  const openUrl = (url: string) => {
    invokeCommand("open_url", { url }).catch(console.error);
  };

  const handleInstall = async (item: CheckItem) => {
    const command = item.installed
      ? item.updateCommand
      : item.installCommand ?? item.updateCommand;
    if (!command) return;
    setInstallingId(item.id);
    try {
      await invokeCommand("install_agent_command", {
        command,
      });
      if (item.id.startsWith("agent-")) {
        await refreshHealth();
      } else {
        const newEnv = await invokeCommand<EnvData>("check_environment");
        setEnv(newEnv);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setInstallingId(null);
    }
  };

  const handleRefresh = async () => {
    setChecking(true);
    try {
      const newEnv = await invokeCommand<EnvData>("check_environment");
      setEnv(newEnv);
      await refreshHealth();

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
        if (agent.install_hint) {
          const pkg = agent.install_hint
            .replace("npm install -g ", "")
            .trim();
          if (pkg) {
            const id = `agent-${agent.id}`;
            if (!packages.some((p) => p[0] === id)) {
              packages.push([id, pkg]);
            }
          }
        }
      }

      if (packages.length > 0) {
        const results = await invokeCommand<LatestVersion[]>(
          "check_available_updates",
          { packages }
        );
        if (results) {
          const map = new Map<string, string>();
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

  if (!env) return <div className="p-8">{t("env.checking")}</div>;

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
                  installing={installingId === item.id}
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
              return (
                <CheckItemRow
                  key={item.id}
                  item={item}
                  installing={installingId === item.id}
                  onInstall={() => handleInstall(item)}
                  onDownload={downloadUrl ? () => openUrl(downloadUrl) : undefined}
                  hasUpdate={hasUpdate(item)}
                  latestVersion={latestVersions.get(item.id)}
                  {...rowLabels}
                />
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
        </div>
        {item.desc && (
          <p className="text-xs text-muted-foreground truncate">{item.desc}</p>
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
            <Button size="sm" variant="outline" onClick={onInstall}>
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
