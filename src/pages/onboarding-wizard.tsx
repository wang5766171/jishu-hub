/**
 * v0.9.7 需求4 + 反馈裁决（2026-11-12 用户原话：「初始安装引导的步骤，
 * 完全放在环境检测页，原来的环境检测完全去掉……不再需要环境检测页了」）：
 * 引导页是**唯一**的安装/初始化界面——原环境检测页整页退役；必须安装的
 * 内容（jishu agent 引擎）即步骤①的初始化门控（mismatch 自愈 + 重试
 * =原检测页手动安装链路的替代）。安装后二次进入：管理菜单「安装引导」
 * 重新打开本页（app 层 forceOnboard）。
 *
 * ① 初始化（只消费不触发——P0-2：启动侧 .setup 无条件 ensure_agent_runtime）：
 *    agent_runtime_status 轮询 + agent-runtime-progress 事件渲染阶段进度；
 *    ready → 进步骤②；init 失败 → 错误态 + 重试（重试=重新初始化引擎，
 *    兼作手动重装入口）。
 * ② 场景选择：6 张粗粒度卡多选（plugin-scenes 单一真源）+ 自定义（跳过）。
 * ③ 场景推荐：插件（market_list_curated 非 required 可装件）+ 技能
 *    （SkillHub 按场景拉取，断网只显插件 + 重试）；勾选安装（逐项状态）。
 * ④ 安装所选 + 开始使用（进入即逐项安装；零选中直接开始）——
 *    「开始使用」→ onComplete（落默认空间由 app 兜底 effect 承接，Q11）。
 * 全程四步（评审 P2-11 修复：头注释对齐实现，原只列到③）；无「先逛逛」
 *（Q1：装完才进主界面）；「进入工作台」只在步骤④出现。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand } from "@/hooks/use-invoke";
import { PLUGIN_SCENES } from "@/lib/plugin-scenes";
import { MIN_NODE_VERSION, isVersionNewer, nodeVersionSatisfies } from "@/agents/version-constants";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ArrowUpCircle,
  Bot,
  Check,
  ChevronLeft,
  Download,
  GraduationCap,
  LineChart,
  Loader2,
  PenLine,
  RefreshCw,
  Video,
  Wrench,
  X,
} from "lucide-react";

const SCENE_ICONS: Record<string, typeof Bot> = {
  programming: Wrench,
  office: PenLine,
  education: GraduationCap,
  video: Video,
  data: LineChart,
  content: Bot,
};

interface AgentRuntimeStatus {
  state: "ready" | "init_running" | "mismatch";
  recorded: string | null;
  expected: string;
}

interface MarketEntry {
  id: string;
  title: string;
  description: string;
  scenes: string[];
  required: boolean;
}

interface SkillhubEntry {
  slug: string;
  name: string;
  description: string;
  version: string;
  score: unknown;
  requires_api_key: boolean;
  publisher_verified: boolean;
}

type InstallState = "idle" | "installing" | "done" | "failed";

export function OnboardingWizard({ onComplete }: { onComplete: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto bg-background px-6 py-8">
      <div className="w-full max-w-2xl">
        {/* 进度指示——收版反馈①②：四步（环境检测为第一步）；已完成的
            步骤圆圈可点击回退。 */}
        <div className="mb-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="flex items-center gap-2">
              <button
                type="button"
                disabled={n >= step}
                onClick={() => setStep(n as 1 | 2 | 3 | 4)}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full border text-xs",
                  step > n
                    ? "border-primary bg-primary text-primary-foreground"
                    : step === n
                      ? "border-primary text-primary"
                      : "border-border/60",
                  n < step && "cursor-pointer hover:opacity-80",
                )}
                title={n < step ? t("onboarding.backToStep", "回到第 {{n}} 步", { n }) : undefined}
              >
                {step > n ? <Check className="h-3 w-3" /> : n}
              </button>
              {n < 4 && <span className="h-px w-8 bg-border/60" />}
            </div>
          ))}
        </div>

        {step === 1 && <EnvPrepStep onReady={() => setStep(2)} />}
        {/* 收版反馈④（2026-11-12 用户裁决）：「自定义（跳过推荐）」只跳过
            当前场景选择步——仍进入推荐步，不再整个引导直接结束。 */}
        {step === 2 && (
          <SceneStep
            onNext={() => setStep(3)}
            onSkip={() => {
              // 收版反馈：改选「自定义」进入时清空场景记录——否则推荐页
              // 仍按上一轮选的场景拉取（返回重选不重置）。
              selectedScenesHolder = [];
              // v0.9.8 需求6：自定义跳过 = 无场景，同步落 settings（建议条不提示）。
              invokeCommand("set_onboarding_scenes", { scenes: [] }).catch(() => {});
              setStep(3);
            }}
          />
        )}
        {step === 3 && (
          <RecommendStep
            scenes={selectedScenesHolder}
            onNext={(items) => {
              installItemsHolder = items;
              setStep(4);
            }}
            onBack={() => setStep(2)}
          />
        )}
        {step === 4 && (
          <InstallStep items={installItemsHolder} onStart={onComplete} onBack={() => setStep(3)} />
        )}
      </div>
    </div>
  );
}

// 步骤②→③ 的选择传递（简单 holder——向导不重挂载，避免状态提升样板）。
let selectedScenesHolder: string[] = [];
// ③→④ 选中清单传递（同款 holder）。
let installItemsHolder: InstallItem[] = [];
// ③ 推荐步勾选与已见推荐项（修复轮回归收口：RecommendStep 条件挂载，
// 返回②再重进会卸载重置——提升为 holder 使「返回重进」同样保留勾选；
// 与 selectedScenesHolder 同款先例）。
let recommendPicksHolder: Set<string> = new Set();
let knownRecommendationsHolder: Set<string> = new Set();


// ── 步骤①：环境准备（引擎初始化 + 运行环境必装项——需求4 反馈裁决：原
// 环境检测页退役，必装项并入引导，装齐才放行）──

interface RuntimeStatusLite {
  id: string;
  installed: boolean;
  version: string | null;
  update_command?: string | null;
  download_url?: string | null;
  latest_package?: string | null;
}

interface EnvData {
  node_installed: boolean;
  node_version: string | null;
  npm_installed: boolean;
  npm_version: string | null;
  python_installed: boolean;
  python_version: string | null;
  git_installed: boolean;
  git_version: string | null;
  runtimes?: RuntimeStatusLite[];
}

function EnvPrepStep({ onReady }: { onReady: () => void }) {
  const { t } = useTranslation();
  const { alert: alertDialog, confirm: confirmDialog, dialogNode: confirmDialogNode } = useConfirmDialog();
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [env, setEnv] = useState<EnvData | null>(null);
  // 收版反馈③（2026-11-12）：运行环境支持检查更新（原环境检测页能力）——
  // npm 可直接更新，其余项给下载入口。
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [latestVersions, setLatestVersions] = useState<Map<string, string>>(new Map());
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const result = await invokeCommand<AgentRuntimeStatus>("agent_runtime_status");
      setStatus(result);
    } catch {
      /* 状态命令失败保持等待 */
    }
  }, []);

  const refreshEnv = useCallback(async () => {
    try {
      setEnv(await invokeCommand<EnvData>("check_environment"));
    } catch {
      /* 检测失败保持等待（可手动重检） */
    }
  }, []);

  useEffect(() => {
    void poll();
    void refreshEnv();
    const timer = window.setInterval(() => void poll(), 2000);
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<{ stage: string }>("agent-runtime-progress", (event) => {
      setStage(event.payload.stage);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unlisten?.();
    };
  }, [poll, refreshEnv]);

  // 启动钩子若已失败（状态停在 mismatch 且无 init-running）→ 展示重试。
  useEffect(() => {
    if (status?.state === "mismatch") setFailed(true);
    else if (status?.state === "init_running" || status?.state === "ready") setFailed(false);
  }, [status?.state]);

  // 必装项判定：引擎 ready + Node（≥ 最低版）+ npm + Git。Python 可选
  // （常用但非 agent 运行根基——缺项提示不拦截）。
  const nodeOk = !!env?.node_installed
    && (!env.node_version || nodeVersionSatisfies(env.node_version, MIN_NODE_VERSION));
  const essentialsOk = status?.state === "ready" && nodeOk && !!env?.npm_installed && !!env?.git_installed;

  const checkUpdates = async () => {
    const packages = (env?.runtimes ?? [])
      .filter((r) => r.latest_package)
      .map((r) => [r.id, r.latest_package as string]);
    if (packages.length === 0) return;
    setCheckingUpdates(true);
    try {
      const results = await invokeCommand<Array<{ id: string; latest_version: string | null }>>(
        "check_available_updates",
        { packages },
      );
      const map = new Map<string, string>();
      for (const r of results ?? []) {
        if (r.latest_version) map.set(r.id, r.latest_version);
      }
      setLatestVersions(map);
    } catch {
      /* 检查失败静默——可重试 */
    } finally {
      setCheckingUpdates(false);
    }
  };

  // 收版反馈（2026-11-12 用户实测「git 点击更新没效果」）：三层修复——
  // ① 提权命令先征得同意（UAC 不再无预期弹出）；② 失败显性弹窗（原静默
  // console.warn=点了没反应）；③ 命令执行成功但重检版本未变化时给出明确
  // 提示（winget 源滞后于 GitHub latest / 新 git 未进当前 PATH 都会走到）。
  const runUpdate = async (id: string, name: string) => {
    const runtime = (env?.runtimes ?? []).find((r) => r.id === id);
    const cmd = runtime?.update_command;
    if (!cmd) return;
    try {
      const needsElevation = await invokeCommand<boolean>(
        "install_command_needs_elevation",
        { command: cmd },
      );
      if (needsElevation) {
        const agreed = await confirmDialog({
          title: t("env.elevationTitle", "需要管理员权限"),
          description: t("env.elevationDesc", {
            defaultValue: `更新「${name}」需要写入系统目录，将以管理员身份执行。点击「同意并继续」后请在系统授权窗口中选择「是」。`,
            name,
          }),
          confirmText: t("env.elevationConfirm", "同意并继续"),
          cancelText: t("common.cancel", "取消"),
        });
        if (!agreed) return;
      }
    } catch {
      /* 提权查询失败不阻断——由命令自身给出结果 */
    }
    setUpdatingId(id);
    try {
      // 多方式策略链（winget→choco→安装包静默装），一种失败自动尝试下一种。
      const result = await invokeCommand<{ method: string; output: string }>("runtime_update", { id });
      const prevVersion = runtime?.version ?? null;
      await refreshEnv();
      // 重检后读新版本（refreshEnv 是 setState——用命令直查一次拿权威值）。
      const fresh = await invokeCommand<EnvData>("check_environment");
      const freshVersion = (fresh.runtimes ?? []).find((r) => r.id === id)?.version ?? null;
      setLatestVersions((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      const methodText = result.method === "installer"
        ? t("onboarding.rtMethodInstaller", "在线安装包")
        : result.method;
      if (freshVersion && prevVersion && freshVersion !== prevVersion) {
        await alertDialog({
          title: t("env.updateSuccess", "更新成功"),
          description: t("onboarding.rtUpdated", {
            defaultValue: `${name} 已通过 ${methodText} 更新到 v${freshVersion}。`,
            name,
            version: freshVersion,
          }),
        });
      } else {
        await alertDialog({
          title: t("onboarding.rtUpdateNoChangeTitle", "更新命令已执行"),
          description: t("onboarding.rtUpdateNoChange", {
            defaultValue: `${name} 的更新命令已执行完成，但检测到的版本仍为${prevVersion ? ` v${prevVersion}` : "原版本"}。可能是更新源尚未提供该新版本，或新版本需要重启应用后生效。`,
            name,
            version: prevVersion ?? "",
          }),
        });
      }
    } catch (err) {
      const errText = String(err);
      if (errText.includes("UAC_CANCELLED")) {
        await alertDialog({
          title: t("env.title", "环境检测"),
          description: t("env.uacCancelled", "已取消管理员授权，更新未执行。可重新更新并在授权弹窗中选择「是」。"), 
        });
      } else {
        const openDownload = await confirmDialog({
          title: t("onboarding.rtUpdateFailed", "更新失败"),
          description: `${errText.slice(0, 400)}`,
          confirmText: t("onboarding.rtOpenDownload", "打开下载页手动更新"),
          cancelText: t("common.cancel", "取消"),
        });
        if (openDownload) openUrl(runtime?.download_url ?? downloadUrls[id] ?? "");
      }
    } finally {
      setUpdatingId(null);
    }
  };

  const stageText =
    stage === "extract"
      ? t("agentRuntime.stageExtract")
      : stage === "install"
        ? t("agentRuntime.stageInstall")
        : stage === "extensions"
          ? t("agentRuntime.stageExtensions")
          : t("agentRuntime.initializing");

  const retry = async () => {
    setRetrying(true);
    try {
      await invokeCommand<string>("agent_runtime_init");
      await poll();
    } catch {
      /* 保持失败态，可再试 */
    } finally {
      setRetrying(false);
    }
  };

  const openUrl = (url: string) => {
    invokeCommand("open_url", { url }).catch(console.error);
  };
  const downloadUrls: Record<string, string> = {
    node: "https://nodejs.org/",
    npm: "https://nodejs.org/",
    git: "https://git-scm.com/downloads",
    python: "https://www.python.org/downloads/",
  };

  // 运行环境行：installed ✓ 版本（+新版本提示/更新入口）/ 缺失→下载入口。
  const renderRuntimeRow = (
    id: "node" | "npm" | "git" | "python",
    ok: boolean,
    version: string | null,
    downloadUrl: string,
    optional?: boolean,
    warn?: string,
  ) => {
    const labels: Record<string, string> = {
      node: t("onboarding.rtNode", "Node.js"),
      npm: t("onboarding.rtNpm", "npm"),
      git: t("onboarding.rtGit", "Git"),
      python: t("onboarding.rtPython", "Python"),
    };
    const runtime = (env?.runtimes ?? []).find((r) => r.id === id);
    const latest = latestVersions.get(id);
    const hasUpdate = ok && !!version && !!latest && isVersionNewer(version, latest);
    const updateCmd = runtime?.update_command ?? undefined;
    // v0.9.8 需求9-④：检测 IPC 未返回前的中间态——此前 env=null 时 ok 恒
    // false，未检测先显「未安装」（用户实测 #7「不具备」观感），先显检测中。
    const checking = env === null;
    return (
      <div key={id} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2.5">
        {checking ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary/70" />
        ) : ok ? (
          <Check className="h-4 w-4 shrink-0 text-[var(--icon-success)]" />
        ) : (
          <X className={cn("h-4 w-4 shrink-0", optional ? "text-muted-foreground/50" : "text-destructive")} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="font-medium">{labels[id]}</span>
            {optional && (
              <span className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                {t("onboarding.rtOptional", "可选")}
              </span>
            )}
          </div>
          {checking ? (
            <div className="text-sm text-muted-foreground">{t("env.checking", "检测中…")}</div>
          ) : ok ? (
            <div className="text-sm text-muted-foreground">
              {version ? `v${version}` : t("env.normal", "已就绪")}
              {hasUpdate && (
                <span className="ml-2 text-amber-600">
                  {t("onboarding.rtNewVersion", "最新 v{{v}}", { v: latest })}
                </span>
              )}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {warn
                ?? (optional
                  ? t("onboarding.rtOptionalMissing", "未安装——不影响引导继续")
                  : t("onboarding.rtMissing", "未安装——点击下载安装，完成后重新检测"))}
            </div>
          )}
        </div>
        {!checking && !ok && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => openUrl(runtime?.download_url ?? downloadUrl)}
          >
            <Download className="h-3.5 w-3.5" />
            <span className="ml-1">{t("onboarding.rtDownload", "下载")}</span>
          </Button>
        )}
        {ok && hasUpdate && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={updatingId === id}
            onClick={() => {
              if (updateCmd) void runUpdate(id, labels[id]);
              else openUrl(runtime?.download_url ?? downloadUrl);
            }}
          >
            {updatingId === id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpCircle className="h-3.5 w-3.5" />
            )}
            <span className="ml-1">{updateCmd ? t("onboarding.rtUpdate", "更新") : t("onboarding.rtDownload", "下载")}</span>
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col items-center gap-5 py-6">
      <div className="text-center">
        <div className="text-lg font-semibold">
          {t("onboarding.initTitle", "正在准备你的智能体")}
        </div>
        <div className="mt-1.5 text-sm text-muted-foreground/70">
          {t("onboarding.initHint", "首次开箱需要几十秒（解压与配置），完成前不进入主界面")}
        </div>
      </div>

      {/* 引擎卡 */}
      <div className="flex w-full items-center gap-3 rounded-lg border border-border/60 px-3 py-2.5">
        {failed ? (
          <X className="h-4 w-4 shrink-0 text-destructive" />
        ) : status?.state === "ready" ? (
          <Check className="h-4 w-4 shrink-0 text-[var(--icon-success)]" />
        ) : (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary/70" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t("onboarding.engineTitle", "智能体引擎")}</div>
          <div className="text-sm text-muted-foreground">
            {failed
              ? t("onboarding.initFailed", "初始化未完成——可重试（重新解压安装引擎）")
              : status?.state === "ready"
                ? `${t("env.normal", "已就绪")} · v${status.expected}`
                : stageText}
          </div>
        </div>
        {failed && (
          <Button size="sm" className="shrink-0" onClick={() => void retry()} disabled={retrying}>
            {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-1.5">{t("onboarding.retry", "重试")}</span>
          </Button>
        )}
      </div>

      {/* 运行环境（必装：Node/npm/Git；可选：Python） */}
      <div className="flex w-full flex-col gap-2">
        <div className="text-sm font-medium text-muted-foreground">{t("onboarding.rtTitle", "运行环境")}</div>
        {renderRuntimeRow("node", nodeOk, env?.node_version ?? null, "https://nodejs.org/", false,
          env?.node_installed && env.node_version && !nodeVersionSatisfies(env.node_version, MIN_NODE_VERSION)
            ? t("onboarding.rtNodeLow", `版本过低 v${env.node_version}（需 ≥ v${MIN_NODE_VERSION}），请升级`)
            : undefined)}
        {renderRuntimeRow("npm", !!env?.npm_installed, env?.npm_version ?? null, "https://nodejs.org/")}
        {renderRuntimeRow("git", !!env?.git_installed, env?.git_version ?? null, "https://git-scm.com/downloads")}
        {renderRuntimeRow("python", !!env?.python_installed, env?.python_version ?? null, "https://www.python.org/downloads/", true)}
        <div className="flex items-center justify-center gap-3 pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-sm text-muted-foreground"
            onClick={() => void refreshEnv()}
          >
            <RefreshCw className="h-4 w-4" />
            <span className="ml-1">{t("onboarding.rtRecheck", "重新检测")}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-sm text-muted-foreground"
            disabled={checkingUpdates}
            onClick={() => void checkUpdates()}
          >
            {checkingUpdates ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpCircle className="h-4 w-4" />}
            <span className="ml-1">{checkingUpdates ? t("env.checkingUpdate", "检查中…") : t("env.checkUpdate", "检查更新")}</span>
          </Button>
        </div>
        {/* 反馈①③：必装项全就绪 → 用户确认进入（检查结果可见，不闪跳）。 */}
        <div className="flex justify-center pt-2">
          <Button size="sm" disabled={!essentialsOk} onClick={onReady}>
            {t("onboarding.next", "下一步")}
          </Button>
        </div>
      </div>
      {/* useConfirmDialog 契约：弹窗节点必须渲染（漏渲染=confirm/alert 的
          Promise 永不落定——更新链 await 卡死、按钮永远转圈）。 */}
      {confirmDialogNode}
    </div>
  );
}

// ── 步骤②：场景选择（6 卡 + 自定义） ──

function SceneStep({ onNext, onSkip }: { onNext: (scenes?: string[]) => void; onSkip: () => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const scenes = useMemo(() => PLUGIN_SCENES.filter((s) => s.id !== "custom"), []);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const proceed = () => {
    selectedScenesHolder = [...selected];
    // v0.9.8 需求6：场景选择落 settings（会话输入框场景建议条的数据源）；
    // 重选场景时重置建议条关闭标志（设计既定：重新选场景即重新唤起建议）。
    invokeCommand("set_onboarding_scenes", { scenes: [...selected] }).catch(() => {});
    invokeCommand("set_scene_suggest_dismissed", { value: false }).catch(() => {});
    onNext();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="text-center">
        <div className="text-lg font-semibold">{t("onboarding.sceneTitle", "你主要用它做什么？")}</div>
        <div className="mt-1.5 text-sm text-muted-foreground">
          {t("onboarding.sceneHint", "可多选——按场景给你配好推荐插件")}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {scenes.map((scene) => {
          const Icon = SCENE_ICONS[scene.id] ?? Bot;
          const active = selected.has(scene.id);
          return (
            <button
              key={scene.id}
              type="button"
              onClick={() => toggle(scene.id)}
              className={cn(
                "flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors",
                active
                  ? "border-primary bg-primary/5"
                  : "border-border/60 bg-muted/20 hover:border-primary/40",
              )}
            >
              <Icon className={cn("h-6 w-6", active ? "text-primary" : "text-primary/70")} />
              <span className="text-sm font-medium">{t(scene.nameKey)}</span>
            </button>
          );
        })}
      </div>
      {/* 需求15-F8：零选中时「下一步」置灰无解释——出口其实在左下（自定义
          跳过），但用户不知道为什么不能继续（首跑自动化即卡于此）。 */}
      {selected.size === 0 && (
        <div className="pb-1.5 text-center text-[11px] text-muted-foreground">
          {t(
            "onboarding.scenePickHint",
            "选择至少一个场景继续，或点左下「自定义（跳过推荐）」",
          )}
        </div>
      )}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onSkip}>
          {t("onboarding.customSkip", "自定义（跳过推荐）")}
        </Button>
        <Button size="sm" disabled={selected.size === 0} onClick={proceed}>
          {t("onboarding.next", "下一步")}
        </Button>
      </div>
    </div>
  );
}

// ── 步骤③：场景推荐 + 安装 + 开始 ──

/** ③→④ 传递的选中项（统一形态，安装步逐项执行）。 */
export interface InstallItem {
  kind: "plugin" | "skill";
  id: string;
  title: string;
  description: string;
  meta?: string;
}

function RecommendStep({
  scenes,
  onNext,
  onBack,
}: {
  scenes: string[];
  onNext: (items: InstallItem[]) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<MarketEntry[]>([]);
  // 需求5（合并版）：所选场景的入门套装（curated bundles 段——粗场景级
  // 兜底；细分场景由会话内自适应推荐卡承担）。套装条目与散装清单互斥
  // （被套装覆盖的条目不再重复出现在散装区）。
  const [bundles, setBundles] = useState<Array<{ title: string; description: string; entries: Array<{ entry: MarketEntry; required: boolean }> }>>([]);
  const [skills, setSkills] = useState<SkillhubEntry[]>([]);
  const [skillError, setSkillError] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(recommendPicksHolder));
  // 收版反馈⑤：选了场景 → 推荐项默认勾上；「自定义（跳过推荐）」进入 →
  // 不默认勾（用户自选）。
  const preselect = scenes.length > 0;
  // 评审 P2-6 修复：preselect 只在首次出现的新项上生效——重试/返回重进
  // 均不再重置勾选（knownPicks 记录已出过的推荐项只合并新项；picked 经
  // 模块级 holder 跨「返回②卸载」存活——修复轮回归收口：条件挂载曾使
  // 返回路径重置勾选）。
  const knownPicksRef = { current: knownRecommendationsHolder };

  const load = useCallback(async () => {
    setSkillError(false);
    // 插件：各场景 curated 非 required 可装件。收版反馈④：跳过场景进入时
    // scenes 为空——改为全部场景各取头部一件合并（多场景代表），洗牌限量，
    // 不再空列表/转圈。
    const scenesToLoad = scenes.length > 0
      ? scenes
      : PLUGIN_SCENES.filter((s) => s.id !== "custom").map((s) => s.id);
    try {
      // 需求5（合并版）：入门套装优先——所选场景有官方套装的以套装形态
      // 呈现（必备锁定+可选勾选）；套装覆盖的条目从散装清单剔除。
      const [fullCurated, bundleList] = await Promise.all([
        invokeCommand<MarketEntry[]>("market_list_curated", { scene: null }),
        invokeCommand<Array<{ id: string; scene: string; title: string; description: string; items: Array<{ ref: string; required: boolean }> }>>("market_list_bundles").catch(() => []),
      ]);
      const entryById = new Map((fullCurated ?? []).map((e) => [e.id, e]));
      const myBundles = (bundleList ?? []).filter((b) => scenes.includes(b.scene));
      const coveredIds = new Set(
        myBundles.flatMap((b) =>
          b.items
            .map((i) => i.ref.replace(/^curated:/, ""))
            .filter((id) => entryById.has(id)),
        ),
      );
      setBundles(
        myBundles.map((b) => ({
          title: b.title,
          description: b.description,
          entries: b.items
            .filter((i) => i.ref.startsWith("curated:") && entryById.has(i.ref.slice("curated:".length)))
            .map((i) => ({ entry: entryById.get(i.ref.slice("curated:".length))!, required: i.required })),
        })),
      );
      // 入门套装口径：默认勾必备（粗场景兜底；可选项默认不勾——微调权在用户）。
      applyPicked((prev) => {
        const next = new Set(prev);
        for (const b of myBundles) {
          for (const item of b.items) {
            if (item.required) next.add(`plugin::${item.ref.replace(/^curated:/, "")}`);
          }
        }
        return next;
      });

      const all: MarketEntry[] = [];
      const seen = new Set<string>();
      for (const scene of scenesToLoad) {
        const entries = await invokeCommand<MarketEntry[]>("market_list_curated", { scene });
        for (const e of entries ?? []) {
          if (!e.required && !seen.has(e.id) && !coveredIds.has(e.id)) {
            seen.add(e.id);
            all.push(e);
          }
        }
      }
      const pickedList = scenes.length > 0 ? all : shuffle(all).slice(0, 6);
      setPlugins(pickedList);
      if (preselect) {
        // 评审 P2-6：只合并首次出现的新项（首次 load=全量勾选，后续 load
        // 保留用户已有勾选）。
        applyPicked((prev) => {
          const next = new Set(prev);
          for (const e of pickedList) {
            const key = `plugin::${e.id}`;
            if (!knownPicksRef.current.has(key)) next.add(key);
          }
          return next;
        });
        for (const e of pickedList) knownPicksRef.current.add(`plugin::${e.id}`);
      }
    } catch {
      /* 插件源内嵌不会失败 */
    }
    // 技能：每场景按评分取前 4（跳过场景时每场景取 1，洗牌限量 6）。
    try {
      const collected: SkillhubEntry[] = [];
      const seenSkill = new Set<string>();
      for (const scene of scenesToLoad) {
        const result = await invokeCommand<{ entries: SkillhubEntry[] }>("skillhub_list", {
          scene,
          keyword: null,
          page: 1,
          pageSize: scenes.length > 0 ? 4 : 1,
        });
        for (const e of result.entries ?? []) {
          if (!seenSkill.has(e.slug)) {
            seenSkill.add(e.slug);
            collected.push(e);
          }
        }
      }
      const skillList = scenes.length > 0 ? collected : shuffle(collected).slice(0, 6);
      setSkills(skillList);
      if (preselect) {
        // 评审 P2-6：与插件同规则——只合并首次出现的新项，不回加用户已
        // 取消勾选的技能。
        applyPicked((prev) => {
          const next = new Set(prev);
          for (const s of skillList) {
            const key = `skill::${s.slug}`;
            if (!knownPicksRef.current.has(key)) next.add(key);
          }
          return next;
        });
        for (const s of skillList) knownPicksRef.current.add(`skill::${s.slug}`);
      }
    } catch {
      setSkillError(true);
    }
  }, [scenes, preselect]);

  useEffect(() => {
    void load();
  }, [load]);

  // picked 变更统一包装：state 与模块级 holder 同步（返回②卸载重进后由
  // holder 恢复，见顶部 holder 声明注释）。
  const applyPicked = (fn: (prev: Set<string>) => Set<string>) => {
    setPicked((prev) => {
      const next = fn(prev);
      recommendPicksHolder = next;
      return next;
    });
  };

  const toggle = (key: string) => {
    applyPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const proceed = () => {
    const items: InstallItem[] = [];
    // 需求5（合并版）：套装条目（必备恒选；可选项走 picked）。
    const bundleSeen = new Set<string>();
    for (const b of bundles) {
      for (const { entry, required } of b.entries) {
        if (bundleSeen.has(entry.id)) continue;
        bundleSeen.add(entry.id);
        if (required || picked.has(`plugin::${entry.id}`)) {
          items.push({ kind: "plugin", id: entry.id, title: entry.title, description: entry.description });
        }
      }
    }
    for (const p of plugins) {
      if (picked.has(`plugin::${p.id}`)) {
        items.push({ kind: "plugin", id: p.id, title: p.title, description: p.description });
      }
    }
    for (const s of skills) {
      if (picked.has(`skill::${s.slug}`)) {
        items.push({ kind: "skill", id: s.slug, title: s.name, description: s.description, meta: s.requires_api_key ? t("onboarding.needsKey", "需要 API Key") : undefined });
      }
    }
    onNext(items);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="text-center">
        <div className="text-lg font-semibold">{t("onboarding.recommendTitle", "按需配齐插件")}</div>
        <div className="mt-1.5 text-sm text-muted-foreground">
          {t("onboarding.recommendHint", "勾选要装的（都可随时在插件市场增删）")}
        </div>
      </div>

      {bundles.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-medium text-muted-foreground">{t("onboarding.recBundles", "入门套装")}</div>
          <div className="space-y-3">
            {bundles.map((b, bi) => (
              <div key={bi} className="rounded-xl border border-primary/35 bg-primary/5 p-3" data-onboarding-bundle={bi}>
                <div className="text-sm font-medium text-foreground">{b.title}</div>
                <div className="mb-2 text-xs text-muted-foreground">{b.description}</div>
                <div className="space-y-1.5">
                  {b.entries.map(({ entry, required }) => {
                    const key = `plugin::${entry.id}`;
                    return (
                      <RecommendRow
                        key={key}
                        checked={required || picked.has(key)}
                        onToggle={() => toggle(key)}
                        title={entry.title}
                        description={entry.description}
                        state="idle"
                        disabled={required}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {plugins.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-medium text-muted-foreground">{t("onboarding.recPlugins", "插件")}</div>
          <div className="space-y-1.5">
            {plugins.map((p) => {
              const key = `plugin::${p.id}`;
              return (
                <RecommendRow
                  key={key}
                  checked={picked.has(key)}
                  onToggle={() => toggle(key)}
                  title={p.title}
                  description={p.description}
                  state="idle"
                  disabled={false}
                />
              );
            })}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 text-sm font-medium text-muted-foreground">{t("onboarding.recSkills", "技能")}</div>
        {skillError ? (
          <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {t("onboarding.skillOffline", "技能市场暂不可用（网络）——可稍后在插件市场安装")}
            <Button variant="outline" size="sm" className="ml-auto h-6 px-2 text-[10px]" onClick={() => void load()}>
              {t("onboarding.retry", "重试")}
            </Button>
          </div>
        ) : skills.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground/70">
            <Loader2 className="mr-1.5 inline h-3 w-3 animate-spin" />
            {t("onboarding.skillLoading", "正在获取推荐技能…")}
          </div>
        ) : (
          <div className="space-y-1.5">
            {skills.map((s) => {
              const key = `skill::${s.slug}`;
              return (
                <RecommendRow
                  key={key}
                  checked={picked.has(key)}
                  onToggle={() => toggle(key)}
                  title={s.name}
                  description={s.description}
                  state="idle"
                  disabled={false}
                  meta={s.requires_api_key ? t("onboarding.needsKey", "需要 API Key") : undefined}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between pt-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
          {t("onboarding.back", "上一步")}
        </Button>
        <Button size="sm" onClick={proceed}>
          {t("onboarding.next", "下一步")}
        </Button>
      </div>
    </div>
  );
}

/** 收版反馈④：跳过场景时的通用推荐——简单洗牌（Fisher-Yates）。 */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 步骤④：安装所选 + 开始使用（进入即逐项安装；零选中直接开始）。 */
function InstallStep({ items, onStart, onBack }: { items: InstallItem[]; onStart: () => void; onBack: () => void }) {
  const { t } = useTranslation();
  const [states, setStates] = useState<Record<string, InstallState>>({});
  const [started, setStarted] = useState(false);

  // 进入即安装（runRef 幂等：严格模式双调用下只装一次）。
  const runRef = useRef(false);
  useEffect(() => {
    if (runRef.current) return;
    runRef.current = true;
    setStarted(true);
    void (async () => {
      const next: Record<string, InstallState> = {};
      for (const item of items) {
        const key = `${item.kind}::${item.id}`;
        next[key] = "installing";
        setStates({ ...next });
        try {
          if (item.kind === "plugin") {
            await invokeCommand<string>("market_install", { pluginId: item.id });
          } else {
            await invokeCommand<string>("skillhub_install", { slug: item.id });
          }
          next[key] = "done";
        } catch {
          next[key] = "failed";
        }
        setStates({ ...next });
      }
      setStarted(false);
    })();
  }, [items]);

  const anyInstalling = started || Object.values(states).some((s) => s === "installing");

  return (
    <div className="flex flex-col gap-4">
      <div className="text-center">
        <div className="text-lg font-semibold">{t("onboarding.installingTitle", "正在安装所选")}</div>
        <div className="mt-1.5 text-sm text-muted-foreground">
          {t("onboarding.installingHint", "安装完成后即可开始使用；失败的项可稍后在插件市场重试")}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          {t("onboarding.noSelection", "没有勾选任何项——直接开始使用")}
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => {
            const key = `${item.kind}::${item.id}`;
            return (
              <RecommendRow
                key={key}
                checked
                onToggle={() => undefined}
                title={item.title}
                description={item.description}
                state={states[key] ?? "idle"}
                disabled
                meta={item.meta}
              />
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={anyInstalling}>
          <ChevronLeft className="h-4 w-4" />
          {t("onboarding.back", "上一步")}
        </Button>
        <Button size="sm" onClick={onStart} disabled={anyInstalling}>
          {t("onboarding.start", "开始使用")}
        </Button>
      </div>
    </div>
  );
}
function RecommendRow({
  checked,
  onToggle,
  title,
  description,
  state,
  disabled,
  meta,
}: {
  checked: boolean;
  onToggle: () => void;
  title: string;
  description: string;
  state: InstallState;
  disabled: boolean;
  meta?: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors",
        checked ? "border-primary/50 bg-primary/5" : "border-border/50 hover:border-primary/30",
        disabled && "cursor-default opacity-90",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        className="mt-0.5 h-3.5 w-3.5 accent-[var(--primary)]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{title}</span>
          {meta && <span className="shrink-0 text-[11px] text-amber-600">{meta}</span>}
        </div>
        <p className="line-clamp-1 text-xs text-muted-foreground" title={description}>
          {description}
        </p>
      </div>
      {state === "installing" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
      {state === "done" && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
      {state === "failed" && <X className="h-3.5 w-3.5 shrink-0 text-destructive" />}
    </label>
  );
}
