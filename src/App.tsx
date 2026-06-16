
import "@/i18n";
import { lazy, Suspense } from "react";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { useTranslation } from "react-i18next";
import { Copy, Minus, Pin, PinOff, Settings, Square, Sun, Palette, Moon, Info, Type, X } from "lucide-react";
import logoSvg from "@/assets/logo.svg";
import logoLightSvg from "@/assets/logo-light.svg";
import { Github } from "@/components/icons/github";
import { Gitee } from "@/components/icons/gitee";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useState, useEffect, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { useTheme, type Theme, ThemeProvider } from "@/hooks/use-theme";
import { useFontSize, type FontLevel } from "@/hooks/use-font-size";
import { AgentProvider, useAgent } from "@/agents";
import { AgentSwitcher } from "@/agents";
import { FileViewerProvider } from "@/components/file-viewer";
import { ErrorBoundary } from "@/components/error-boundary";
import type { Page, Project, ProjectMeta } from "@/types";

const ChatPage = lazy(() => import("@/pages/chat-page").then(m => ({ default: m.ChatPage })));
const ManagePage = lazy(() => import("@/pages/manage-page").then(m => ({ default: m.ManagePage })));

const themeConfig: Record<Theme, { icon: typeof Sun; labelKey: string }> = {
  light: { icon: Sun, labelKey: "theme.light" },
  colorful: { icon: Palette, labelKey: "theme.colorful" },
  dark: { icon: Moon, labelKey: "theme.dark" },
};
const themeOrder: Theme[] = ["light", "colorful", "dark"];
const appWindow = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? getCurrentWindow() : null;

const fontLevels: { id: FontLevel; labelKey: string }[] = [
  { id: "s", labelKey: "fontSize.small" },
  { id: "m", labelKey: "fontSize.medium" },
  { id: "l", labelKey: "fontSize.large" },
  { id: "xl", labelKey: "fontSize.xlarge" },
];

function FontSizeRow({ label, value, onChange, t }: { label: string; value: FontLevel; onChange: (v: FontLevel) => void; t: (k: string) => string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground w-14 shrink-0">{label}</span>
      <div className="flex gap-1">
        {fontLevels.map(({ id, labelKey }) => (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={cn(
              "px-2 py-0.5 rounded text-[11px] transition-fast",
              value === id
                ? "bg-primary text-primary-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

function LoadingOverlay({ label }: { label?: string }) {
  const { theme } = useTheme();
  const src = theme === "light" ? logoLightSvg : logoSvg;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3">
        <div className="relative h-14 w-14">
          <div className="absolute inset-0 rounded-full border-2 border-muted-foreground/20" />
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-primary animate-spin" />
          <img src={src} alt="" className="absolute inset-2 h-10 w-10 rounded-lg" />
        </div>
        {label && (
          <div className="rounded-full border border-border/60 bg-card/90 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm">
            {label}
          </div>
        )}
      </div>
    </div>
  );
}

function TitleBar({ currentPage, onNavigate, disabled }: { currentPage: Page; onNavigate: (page: Page) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [pinned, setPinned] = useState(false);
  const [version, setVersion] = useState("");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [aboutHovered, setAboutHovered] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ latest_version: string | null; has_update: boolean; release_url: string; error: string | null } | null>(null);
  const [updateReady, setUpdateReady] = useState<{ version: string; path: string } | null>(null);
  const [fontOpen, setFontOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const { theme, setTheme } = useTheme();
  const logo = theme === "light" ? logoLightSvg : logoSvg;
  const { fontSizeBase, fontSizeProse, setFontSizeBase, setFontSizeProse } = useFontSize();
  const { active } = useAgent();
  const aboutRef = useRef<HTMLDivElement>(null);
  const fontRef = useRef<HTMLDivElement>(null);
  const aboutTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    invokeCommand<boolean>("load_always_on_top").then(setPinned).catch(console.error);
    getVersion().then((v) => setVersion(v)).catch(() => setVersion(""));
    appWindow?.isMaximized().then(setMaximized).catch((e) => { if (import.meta.env.DEV) console.warn("IPC failed:", e); });
    // Background auto-update: check + download a newer installer on startup.
    invokeCommand<{ version: string | null; installer_path: string | null }>("download_update")
      .then((r) => {
        if (r.installer_path && r.version) setUpdateReady({ version: r.version, path: r.installer_path });
      })
      .catch((e) => { if (import.meta.env.DEV) console.warn("IPC failed:", e); });
  }, []);

  useEffect(() => {
    if (!appWindow) return;

    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;

    appWindow.onResized(() => {
      if (timer != null) return;
      timer = setTimeout(async () => {
        timer = null;
        const m = await appWindow!.isMaximized();
        setMaximized(prev => prev === m ? prev : m);
      }, 200);
    }).then((fn) => {
      unlisten = fn;
    }).catch((e) => { if (import.meta.env.DEV) console.warn("IPC failed:", e); });

    return () => { unlisten?.(); if (timer) clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (!aboutOpen && !fontOpen) return;
    const handler = (e: MouseEvent) => {
      if (aboutOpen && aboutRef.current && !aboutRef.current.contains(e.target as Node)) {
        setAboutOpen(false);
      }
      if (fontOpen && fontRef.current && !fontRef.current.contains(e.target as Node)) {
        setFontOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [aboutOpen, fontOpen]);

  const handleToggle = async () => {
    try {
      const newValue = await invokeCommand<boolean>("toggle_always_on_top");
      setPinned(newValue);
    } catch (e) {
      console.error(e);
    }
  };

  const minimizeWindow = () => {
    appWindow?.minimize().catch(console.error);
  };

  const toggleMaximizeWindow = async () => {
    if (!appWindow) return;

    try {
      await appWindow.toggleMaximize();
      setMaximized(await appWindow.isMaximized());
    } catch (e) {
      console.error(e);
    }
  };

  const closeWindow = () => {
    appWindow?.close().catch(console.error);
  };

  const cycleTheme = () => {
    const idx = themeOrder.indexOf(theme);
    setTheme(themeOrder[(idx + 1) % themeOrder.length]);
  };

  const scheduleAboutClose = () => {
    aboutTimerRef.current = setTimeout(() => {
      if (!aboutHovered) setAboutOpen(false);
    }, 150);
  };
  const cancelAboutClose = () => {
    if (aboutTimerRef.current) clearTimeout(aboutTimerRef.current);
    setAboutHovered(true);
  };

  const handleCheckUpdate = async () => {
    if (updateChecking) return;
    setUpdateChecking(true);
    setUpdateResult(null);
    try {
      setUpdateResult(
        await invokeCommand<{ latest_version: string | null; has_update: boolean; release_url: string; error: string | null }>("check_for_update")
      );
    } catch {
      setUpdateResult({ latest_version: null, has_update: false, release_url: "", error: "failed" });
    } finally {
      setUpdateChecking(false);
    }
  };

  const { icon: ThemeIcon, labelKey: themeLabelKey } = themeConfig[theme];
  const themeLabel = t(themeLabelKey);

  return (
    <div
      className="flex h-11 items-center border-b border-border/30 pl-3 select-none"
      style={{ background: "var(--color-layer-0)", WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {updateReady && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <div className="w-80 rounded-xl border border-border bg-card p-5 shadow-xl">
            <h3 className="mb-1.5 text-sm font-semibold">{t("about.updateReadyTitle")}</h3>
            <p className="mb-4 text-xs text-muted-foreground">{t("about.updateReadyDesc", { version: updateReady.version })}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setUpdateReady(null)}
                className="h-8 px-3 rounded-md text-xs text-muted-foreground hover:bg-accent/50 transition-fast"
              >
                {t("about.later")}
              </button>
              <button
                onClick={() => invokeCommand("install_update", { installerPath: updateReady.path }).catch(console.error)}
                className="h-8 px-3 rounded-md text-xs bg-primary text-primary-foreground hover:opacity-90 transition-fast"
              >
                {t("about.restartNow")}
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        className="mr-1 flex h-full w-8 shrink-0 items-center justify-start"
        onDoubleClick={toggleMaximizeWindow}
      >
        <img src={logo} alt="" draggable={false} className="pointer-events-none h-6 w-6 rounded-md shadow-sm" />
      </div>

      <div className="flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <button
          onClick={disabled ? undefined : () => onNavigate(currentPage === "chat" ? "manage" : "chat")}
          className={cn(
            "h-7 px-3 rounded-md flex items-center gap-1.5 text-xs transition-fast",
            disabled && "pointer-events-none opacity-50",
            currentPage === "manage"
              ? "bg-accent/80 text-accent-foreground font-medium shadow-sm"
              : "text-muted-foreground hover:bg-accent/30 hover:text-foreground"
          )}
        >
          <Settings className="h-3.5 w-3.5 text-[var(--icon-config)]" />
          <span>{t("nav.config")}</span>
        </button>
        <button
          onClick={cycleTheme}
          className="h-7 px-3 rounded-md flex items-center gap-1.5 text-xs transition-fast text-muted-foreground hover:bg-accent/30 hover:text-foreground"
          title={themeLabel}
        >
          <ThemeIcon className="h-3.5 w-3.5 text-[var(--icon-theme)]" />
          <span>{themeLabel}</span>
        </button>
        <div className="relative" ref={fontRef}>
          <button
            onClick={() => setFontOpen(!fontOpen)}
            className={cn(
              "h-7 px-3 rounded-md flex items-center gap-1.5 text-xs transition-fast text-muted-foreground hover:bg-accent/30 hover:text-foreground",
              fontOpen && "bg-accent/30 text-foreground"
            )}
            title={t("fontSize.title")}
          >
            <Type className="h-3.5 w-3.5 text-[var(--icon-theme)]" />
            <span>{t("fontSize.title")}</span>
          </button>
          {fontOpen && (
            <div className="absolute left-0 top-full mt-1 w-64 rounded-lg border border-border bg-card shadow-lg z-50 p-3 space-y-2">
              <FontSizeRow label={t("fontSize.ui")} value={fontSizeBase} onChange={setFontSizeBase} t={t} />
              <FontSizeRow label={t("fontSize.prose")} value={fontSizeProse} onChange={setFontSizeProse} t={t} />
            </div>
          )}
        </div>
        <div className="relative" ref={aboutRef}>
          <button
            onClick={() => setAboutOpen(!aboutOpen)}
            onMouseLeave={aboutOpen ? scheduleAboutClose : undefined}
            className={cn(
              "h-7 px-3 rounded-md flex items-center gap-1.5 text-xs transition-fast text-muted-foreground hover:bg-accent/30 hover:text-foreground",
              aboutOpen && "bg-accent/30 text-foreground"
            )}
            title={t("about.title")}
          >
            <Info className="h-3.5 w-3.5 text-[var(--icon-about)]" />
            <span>{t("about.title")}</span>
          </button>
          {aboutOpen && (
            <div
              className="absolute left-0 top-full mt-1 w-56 rounded-lg border border-border bg-card shadow-lg z-50 p-4"
              onMouseEnter={cancelAboutClose}
              onMouseLeave={() => { setAboutHovered(false); setAboutOpen(false); }}
            >
              <div
                onClick={handleCheckUpdate}
                title={t("about.checkUpdate")}
                className="flex items-center gap-2 mb-2 -mx-1 px-1 py-0.5 rounded-md cursor-pointer hover:bg-accent/40 transition-fast"
              >
                <img src={logo} alt="" className="h-6 w-6 rounded" />
                <span className="text-sm font-semibold">Jishu Hub</span>
                {version && <span className="text-[0.7em] text-muted-foreground font-mono">v{version}</span>}
              </div>
              {(updateChecking || updateResult) && (
                <div className="-mt-1 mb-1 text-[11px]">
                  {updateChecking ? (
                    <span className="text-muted-foreground">{t("about.checking")}</span>
                  ) : updateResult?.error ? (
                    <span className="text-muted-foreground">{t("about.checkFailed")}</span>
                  ) : updateResult?.has_update ? (
                    <button
                      onClick={() => invokeCommand("open_url", { url: updateResult.release_url }).catch(console.error)}
                      className="text-left text-[var(--icon-about)] hover:underline"
                    >
                      {t("about.newVersion", { version: updateResult.latest_version })}
                    </button>
                  ) : (
                    <span className="text-[var(--icon-success)]">{t("about.latest")}</span>
                  )}
                </div>
              )}
              <div className="flex flex-col gap-1.5 mt-3">
                <button
                  onClick={() => invokeCommand("open_url", { url: "https://github.com/wang5766171/jishu-hub" }).catch(console.error)}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-fast w-full"
                >
                  <Github className="h-3.5 w-3.5 text-[var(--icon-config)]" />
                  <span>GitHub</span>
                </button>
                <button
                  onClick={() => invokeCommand("open_url", { url: "https://gitee.com/wangzwa/jishu-hub" }).catch(console.error)}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-fast w-full"
                >
                  <Gitee className="h-3.5 w-3.5 text-[var(--icon-about)]" />
                  <span>Gitee</span>
                </button>
              </div>
            </div>
          )}
        </div>
        <button
          onClick={handleToggle}
          className={cn(
            "h-7 px-3 rounded-md flex items-center gap-1.5 text-xs transition-fast",
            pinned ? "text-primary" : "text-muted-foreground hover:bg-accent/30 hover:text-foreground"
          )}
          title={pinned ? "取消置顶" : "置顶窗口"}
        >
          {pinned ? <PinOff className="h-3.5 w-3.5 text-[var(--icon-pin)]" /> : <Pin className="h-3.5 w-3.5 text-[var(--icon-pin)]" />}
          <span>{pinned ? t("about.unpin") : t("about.pin")}</span>
        </button>
        <div className="flex items-center ml-1 mr-2 px-1.5 py-0.5 rounded-full bg-accent/20 border border-border/30 hover:bg-accent/40 transition-colors">
          <AgentSwitcher>
            {active && (
              <span className="text-[11px] font-medium text-muted-foreground">{active.display_name}</span>
            )}
          </AgentSwitcher>
        </div>
      </div>
      <div className="min-w-8 flex-1 self-stretch" onDoubleClick={toggleMaximizeWindow} />
      <div className="ml-2 flex h-full items-stretch" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <button
          type="button"
          onClick={minimizeWindow}
          className="flex w-11 items-center justify-center text-muted-foreground transition-fast hover:bg-accent/50 hover:text-foreground"
          title="Minimize"
          aria-label="Minimize"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={toggleMaximizeWindow}
          className="flex w-11 items-center justify-center text-muted-foreground transition-fast hover:bg-accent/50 hover:text-foreground"
          title={maximized ? "Restore" : "Maximize"}
          aria-label={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={closeWindow}
          className="flex w-11 items-center justify-center text-muted-foreground transition-fast hover:bg-red-500 hover:text-white"
          title="Close"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function AppContent() {
  const { activeId, setActive } = useAgent();
  const [currentPage, setCurrentPage] = useState<Page>("chat");
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [projectSessionsLoading, setProjectSessionsLoading] = useState(false);
  const [initialProjectRestored, setInitialProjectRestored] = useState(false);
  const { data: projects, loading: projectsLoading, refetch: refetchProjects } = useInvoke<Project[]>("scan_projects");
  const { data: sessionNames, loading: namesLoading, refetch: refetchNames } = useInvoke<Record<string, string>>("get_session_names");
  const { data: projectMetas, refetch: refetchProjectMetas } = useInvoke<Record<string, ProjectMeta>>("load_project_metas");
  const activeRefreshReadyRef = useRef(false);

  // Only show loading overlay on initial load, not on refresh
  const loading = projectsLoading || namesLoading;
  const blockingLoading = loading || !initialProjectRestored || projectSessionsLoading;

  // Restore last project on startup
  useEffect(() => {
    if (!projects || initialProjectRestored) return;
    let cancelled = false;
    invokeCommand<string | null>("load_last_project")
      .then((lastEncoded) => {
        if (cancelled) return;
        if (lastEncoded) {
          const found = projects.find(p => p.encoded_name === lastEncoded);
          if (found) {
            setProjectSessionsLoading(true);
            setCurrentProject(found);
          }
        }
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setInitialProjectRestored(true);
      });
    return () => { cancelled = true; };
  }, [projects, initialProjectRestored]);

  // Refresh handler: directly await refetch Promises in the event handler
  const handleRefresh = useCallback(async (): Promise<number> => {
    const newProjects = await refetchProjects();
    setCurrentProject(prev => {
      if (!prev) return null;
      return newProjects.find(p => p.encoded_name === prev.encoded_name) ?? null;
    });
    await refetchNames(true);
    await refetchProjectMetas(true);
    return Date.now();
  }, [refetchProjects, refetchNames, refetchProjectMetas]);

  const handleEnterProject = useCallback(async (project: Project) => {
    setProjectSessionsLoading(true);
    refetchProjectMetas(true).catch(console.error);
    setCurrentProject(project);
    invokeCommand("save_last_project", { encodedName: project.encoded_name }).catch(console.error);
    setCurrentPage("chat");
  }, [refetchProjectMetas]);

  const [manageNavKey, setManageNavKey] = useState(0);

  const handleSwitchProject = useCallback(() => {
    setProjectSessionsLoading(false);
    setManageNavKey(k => k + 1);
    setCurrentPage("manage");
  }, []);

  const handleProjectSessionsLoadingChange = useCallback((nextLoading: boolean) => {
    setProjectSessionsLoading((prev) => prev === nextLoading ? prev : nextLoading);
  }, []);

  useEffect(() => {
    if (!activeId) return;
    const silent = !activeRefreshReadyRef.current;
    activeRefreshReadyRef.current = true;
    refetchProjects(silent)
      .then((newProjects) => {
        setCurrentProject((prev) => {
          if (!prev) return null;
          return newProjects.find((p) => p.encoded_name === prev.encoded_name) ?? null;
        });
      })
      .catch(console.error);
    refetchNames(true).catch(console.error);
    refetchProjectMetas(true).catch(console.error);
  }, [activeId, refetchProjects, refetchNames, refetchProjectMetas]);

  const currentProjectMeta = currentProject ? projectMetas?.[currentProject.encoded_name] : undefined;

  // Floating window restore: switch agent/project and navigate to session
  const [navigateToSession, setNavigateToSession] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;
    listen<{ sessionId: string; agentId: string; projectEncoded: string }>("floating-restore", async (event) => {
      if (cancelled) return;
      const { sessionId, agentId, projectEncoded } = event.payload;
      // Switch agent if needed
      if (agentId && agentId !== activeId) {
        await setActive(agentId);
      }
      // Switch project if needed
      if (projectEncoded) {
        const targetProject = projects?.find(p => p.encoded_name === projectEncoded);
        if (targetProject) {
          setCurrentProject(targetProject);
          invokeCommand("save_last_project", { encodedName: projectEncoded }).catch(console.error);
        }
      }
      setCurrentPage("chat");
      // Use setTimeout to ensure project/agent switch effects run first
      setTimeout(() => setNavigateToSession(sessionId), 100);
      // Clear after navigation
      setTimeout(() => setNavigateToSession(null), 500);
      // Focus main window
      getCurrentWindow().setFocus().catch((e) => { if (import.meta.env.DEV) console.warn("IPC failed:", e); });
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenFn = fn;
    });
    return () => { cancelled = true; unlistenFn?.(); };
  }, [activeId, projects, setActive]);

  // Diagnostic: surface the REAL transport dispatch path in the F12 console so
  // the actual command route (ACP vs CLI) is inspectable at runtime — this is
  // the subprocess genuinely spawned, not the probe/declarative surface. No UI;
  // look for `[dispatch] <agent> -> <transport>` in DevTools console.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    listen<{
      agent_id: string;
      session_id: string;
      transport: string;
      program: string | null;
      pid: number;
    }>("agent-dispatch", (event) => {
      const { agent_id, session_id, transport, program, pid } = event.payload;
      console.info(
        `%c[dispatch] ${agent_id} → ${transport}${program ? ` (${program})` : ""}`,
        "color:#6366f1;font-weight:600",
        { session_id, pid, transport, program }
      );
    })
      .then((fn) => { unlistenFn = fn; })
      .catch(console.error);
    return () => { unlistenFn?.(); };
  }, []);

  return (
    <div className="flex flex-col h-screen bg-background relative">
      <TitleBar currentPage={currentPage} onNavigate={setCurrentPage} disabled={blockingLoading} />
      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<LoadingOverlay />}>
          {currentPage === "chat"
            ? <ChatPage currentProject={currentProject} currentProjectMeta={currentProjectMeta} onRefresh={handleRefresh} sessionNames={sessionNames} refetchNames={refetchNames} onSwitchProject={handleSwitchProject} onProjectSessionsLoadingChange={handleProjectSessionsLoadingChange} navigateToSession={navigateToSession} />
            : <ManagePage onBack={() => setCurrentPage("chat")} onEnterProject={handleEnterProject} navigateToProjects={manageNavKey} />}
        </Suspense>
      </div>
      <div className="h-6 flex items-center px-4 text-[10px] text-muted-foreground/50 border-t border-border/30">
        <span>{projects?.length ?? 0} projects</span>
      </div>
      {blockingLoading && <LoadingOverlay />}
    </div>
  );
}

import { EnvCheckPage } from "@/pages/env-check-page";

function AppContentWrapper() {
  const [envChecked, setEnvChecked] = useState(!!localStorage.getItem("jishu-hub-env-checked"));

  if (!envChecked) {
    return (
      <div className="flex flex-col h-screen w-screen bg-background text-foreground relative">
        <TitleBar currentPage={"chat"} onNavigate={() => {}} disabled={true} />
        <div className="flex-1 overflow-hidden bg-background">
          <EnvCheckPage onComplete={() => { localStorage.setItem("jishu-hub-env-checked", "1"); setEnvChecked(true); }} />
        </div>
      </div>
    );
  }

  return <AppContent />;
}

function App() {
  return (
    <ThemeProvider>
      <AgentProvider>
        <FileViewerProvider>
          <ErrorBoundary>
            <AppContentWrapper />
          </ErrorBoundary>
        </FileViewerProvider>
      </AgentProvider>
    </ThemeProvider>
  );
}

export default App;
