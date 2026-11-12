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
 *    （SkillHub 按场景拉取，断网只显插件 + 重试）；勾选安装（逐项状态）；
 *    「开始使用」→ onComplete（落默认空间由 app 兜底 effect 承接，Q11）。
 * 无「先逛逛」（Q1：装完才进主界面）；「进入工作台」只在步骤③出现。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand } from "@/hooks/use-invoke";
import { PLUGIN_SCENES } from "@/lib/plugin-scenes";
import { MIN_NODE_VERSION, nodeVersionSatisfies } from "@/agents/version-constants";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
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
  const [step, setStep] = useState<1 | 2 | 3>(1);

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto bg-background px-6 py-8">
      <div className="w-full max-w-2xl">
        {/* 进度指示 */}
        <div className="mb-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          {[1, 2, 3].map((n) => (
            <div key={n} className="flex items-center gap-2">
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full border text-[10px]",
                  step > n
                    ? "border-primary bg-primary text-primary-foreground"
                    : step === n
                      ? "border-primary text-primary"
                      : "border-border/60",
                )}
              >
                {step > n ? <Check className="h-3 w-3" /> : n}
              </span>
              {n < 3 && <span className="h-px w-8 bg-border/60" />}
            </div>
          ))}
        </div>

        {step === 1 && <EnvPrepStep onReady={() => setStep(2)} />}
        {step === 2 && (
          <SceneStep onNext={() => setStep(3)} onSkip={onComplete} />
        )}
        {step === 3 && (
          <RecommendStep scenes={selectedScenesHolder} onStart={onComplete} onBack={() => setStep(2)} />
        )}
      </div>
    </div>
  );
}

// 步骤②→③ 的选择传递（简单 holder——向导不重挂载，避免状态提升样板）。
let selectedScenesHolder: string[] = [];

// ── 步骤①：环境准备（引擎初始化 + 运行环境必装项——需求4 反馈裁决：原
// 环境检测页退役，必装项并入引导，装齐才放行）──

interface EnvData {
  node_installed: boolean;
  node_version: string | null;
  npm_installed: boolean;
  npm_version: string | null;
  python_installed: boolean;
  python_version: string | null;
  git_installed: boolean;
  git_version: string | null;
}

function EnvPrepStep({ onReady }: { onReady: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [env, setEnv] = useState<EnvData | null>(null);

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
  useEffect(() => {
    if (essentialsOk) onReady();
  }, [essentialsOk, onReady]);

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

  // 运行环境行（必装三件套 + 可选 Python）：installed ✓ 版本 / 缺失→下载入口。
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
    return (
      <div key={id} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
        {ok ? (
          <Check className="h-4 w-4 shrink-0 text-[var(--icon-success)]" />
        ) : (
          <X className={cn("h-4 w-4 shrink-0", optional ? "text-muted-foreground/50" : "text-destructive")} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="font-medium">{labels[id]}</span>
            {optional && (
              <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                {t("onboarding.rtOptional", "可选")}
              </span>
            )}
          </div>
          {ok ? (
            <div className="text-xs text-muted-foreground">
              {version ? `v${version}` : t("env.normal", "已就绪")}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {warn
                ?? (optional
                  ? t("onboarding.rtOptionalMissing", "未安装——不影响引导继续")
                  : t("onboarding.rtMissing", "未安装——点击下载安装，完成后重新检测"))}
            </div>
          )}
        </div>
        {!ok && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => openUrl(downloadUrl)}
          >
            <Download className="h-3.5 w-3.5" />
            <span className="ml-1">{t("onboarding.rtDownload", "下载")}</span>
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
        <div className="mt-1 text-xs text-muted-foreground/60">
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
          <div className="text-xs text-muted-foreground">
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
        <div className="text-xs font-medium text-muted-foreground">{t("onboarding.rtTitle", "运行环境")}</div>
        {renderRuntimeRow("node", nodeOk, env?.node_version ?? null, "https://nodejs.org/", false,
          env?.node_installed && env.node_version && !nodeVersionSatisfies(env.node_version, MIN_NODE_VERSION)
            ? t("onboarding.rtNodeLow", `版本过低 v${env.node_version}（需 ≥ v${MIN_NODE_VERSION}），请升级`)
            : undefined)}
        {renderRuntimeRow("npm", !!env?.npm_installed, env?.npm_version ?? null, "https://nodejs.org/")}
        {renderRuntimeRow("git", !!env?.git_installed, env?.git_version ?? null, "https://git-scm.com/downloads")}
        {renderRuntimeRow("python", !!env?.python_installed, env?.python_version ?? null, "https://www.python.org/downloads/", true)}
        <div className="flex justify-center pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => void refreshEnv()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span className="ml-1">{t("onboarding.rtRecheck", "重新检测")}</span>
          </Button>
        </div>
      </div>
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
    onNext();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="text-center">
        <div className="text-lg font-semibold">{t("onboarding.sceneTitle", "你主要用它做什么？")}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {t("onboarding.sceneHint", "可多选——按场景给你配好推荐装备")}
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

function RecommendStep({
  scenes,
  onStart,
  onBack,
}: {
  scenes: string[];
  onStart: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<MarketEntry[]>([]);
  const [skills, setSkills] = useState<SkillhubEntry[]>([]);
  const [skillError, setSkillError] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [installStates, setInstallStates] = useState<Record<string, InstallState>>({});
  const [installing, setInstalling] = useState(false);

  const load = useCallback(async () => {
    setSkillError(false);
    // 插件：各场景 curated 非 required 可装件。
    try {
      const all: MarketEntry[] = [];
      const seen = new Set<string>();
      for (const scene of scenes) {
        const entries = await invokeCommand<MarketEntry[]>("market_list_curated", { scene });
        for (const e of entries ?? []) {
          if (!e.required && !seen.has(e.id)) {
            seen.add(e.id);
            all.push(e);
          }
        }
      }
      setPlugins(all);
      setPicked(new Set(all.map((e) => e.id)));
    } catch {
      /* 插件源内嵌不会失败 */
    }
    // 技能：每场景按评分取前 4（SkillHub 在线）。
    if (scenes.length === 0) return;
    try {
      const collected: SkillhubEntry[] = [];
      const seenSkill = new Set<string>();
      for (const scene of scenes) {
        const result = await invokeCommand<{ entries: SkillhubEntry[] }>("skillhub_list", {
          scene,
          keyword: null,
          page: 1,
          pageSize: 4,
        });
        for (const e of result.entries ?? []) {
          if (!seenSkill.has(e.slug)) {
            seenSkill.add(e.slug);
            collected.push(e);
          }
        }
      }
      setSkills(collected);
    } catch {
      setSkillError(true);
    }
  }, [scenes]);

  useEffect(() => {
    void load();
  }, [load]);

  const installAll = async () => {
    setInstalling(true);
    const next: Record<string, InstallState> = { ...installStates };
    for (const key of picked) {
      const [kind, id] = key.split("::");
      next[key] = "installing";
      setInstallStates({ ...next });
      try {
        if (kind === "plugin") {
          await invokeCommand<string>("market_install", { pluginId: id });
        } else {
          await invokeCommand<string>("skillhub_install", { slug: id });
        }
        next[key] = "done";
      } catch {
        next[key] = "failed";
      }
      setInstallStates({ ...next });
    }
    setInstalling(false);
  };

  const toggle = (key: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const anyInstalling = Object.values(installStates).some((s) => s === "installing") || installing;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-center">
        <div className="text-lg font-semibold">{t("onboarding.recommendTitle", "按需配齐装备")}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {t("onboarding.recommendHint", "勾选要装的（都可随时在插件市场增删）")}
        </div>
      </div>

      {plugins.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">{t("onboarding.recPlugins", "插件")}</div>
          <div className="space-y-1.5">
            {plugins.map((p) => {
              const key = `plugin::${p.id}`;
              const state = installStates[key] ?? "idle";
              return (
                <RecommendRow
                  key={key}
                  checked={picked.has(key)}
                  onToggle={() => toggle(key)}
                  title={p.title}
                  description={p.description}
                  state={state}
                  disabled={state === "done" || state === "installing"}
                />
              );
            })}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">{t("onboarding.recSkills", "技能")}</div>
        {skillError ? (
          <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {t("onboarding.skillOffline", "技能市场暂不可用（网络）——可稍后在插件市场安装")}
            <Button variant="outline" size="sm" className="ml-auto h-6 px-2 text-[10px]" onClick={() => void load()}>
              {t("onboarding.retry", "重试")}
            </Button>
          </div>
        ) : skills.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground/70">
            <Loader2 className="mr-1.5 inline h-3 w-3 animate-spin" />
            {t("onboarding.skillLoading", "正在获取推荐技能…")}
          </div>
        ) : (
          <div className="space-y-1.5">
            {skills.map((s) => {
              const key = `skill::${s.slug}`;
              const state = installStates[key] ?? "idle";
              return (
                <RecommendRow
                  key={key}
                  checked={picked.has(key)}
                  onToggle={() => toggle(key)}
                  title={s.name}
                  description={s.description}
                  state={state}
                  disabled={state === "done" || state === "installing"}
                  meta={s.requires_api_key ? t("onboarding.needsKey", "需要 API Key") : undefined}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between pt-2">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={anyInstalling}>
          <ChevronLeft className="h-4 w-4" />
          {t("onboarding.back", "上一步")}
        </Button>
        <div className="flex items-center gap-2">
          {picked.size > 0 && !anyInstalling && Object.values(installStates).every((s) => s === "idle") && (
            <Button variant="outline" size="sm" onClick={() => void installAll()}>
              <Download className="h-4 w-4" />
              <span className="ml-1.5">{t("onboarding.installSelected", "安装所选")}</span>
            </Button>
          )}
          <Button
            size="sm"
            onClick={onStart}
            disabled={anyInstalling}
          >
            {t("onboarding.start", "开始使用")}
          </Button>
        </div>
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
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <span className="truncate">{title}</span>
          {meta && <span className="shrink-0 text-[10px] text-amber-600">{meta}</span>}
        </div>
        <p className="line-clamp-1 text-[11px] text-muted-foreground" title={description}>
          {description}
        </p>
      </div>
      {state === "installing" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
      {state === "done" && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
      {state === "failed" && <X className="h-3.5 w-3.5 shrink-0 text-destructive" />}
    </label>
  );
}
