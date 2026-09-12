/**
 * HTML 页面预览插件（v0.9.2 测试期，两轮形态演进定稿：sidebar-panel）。
 *
 * 双挂载声明（严格插件机制，无内核/页面特判）：
 * - event-hook：常驻消费内核信号 file-preview-request（agent 的 preview_html
 *   工具经内核事件管线转发）→ 记录当前文件 + ctx.openPanel 展开自己；
 * - sidebar-panel：挤压式侧栏 UI——左侧「本会话产出的 HTML」清单（从
 *   ctx.messages 的 tool_use 块提取 .html/.htm 路径，人工点选），右侧
 *   iframe srcDoc 渲染（sandbox 允许脚本/表单/弹窗，不给同源）。
 *
 * 与 session.html-render（markdown 代码块内联渲染）互补：本插件面向
 * 「文件形态的页面产物」，agent 主动调用（工具描述）+ 用户手动点选。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AppWindow, FolderOpen, Globe, List, MoreHorizontal, RotateCw, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { invokeCommand } from "@/hooks/use-invoke";
import { cn } from "@/lib/utils";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor, SessionKernelContext, PluginMessage } from "../types";

// ── 插件私有状态（当前预览文件；event-hook 写入，面板读取）──

interface PreviewState {
  file: string | null;
  /** 自增：同一文件再次请求也驱动重载。 */
  version: number;
}

let previewState: PreviewState = { file: null, version: 0 };
const previewListeners = new Set<() => void>();

function setPreviewFile(file: string): void {
  previewState = { file, version: previewState.version + 1 };
  for (const fn of previewListeners) fn();
}

/** 清除当前预览（无选择态；关闭最后一个标签时使用）。 */
function clearPreviewFile(): void {
  previewState = { file: null, version: previewState.version + 1 };
  for (const fn of previewListeners) fn();
}

function getPreviewSnapshot(): PreviewState {
  return previewState;
}

function subscribePreview(cb: () => void): () => void {
  previewListeners.add(cb);
  return () => previewListeners.delete(cb);
}

// ── 会话产物提取（ctx.messages 契约数据面）──

/** Windows 盘符 / UNC / POSIX 绝对路径判定。 */
function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

/** 相对路径以项目根解析（agent 写文件常用相对路径，read_text_file 按
 * 绝对路径读；projectPath 来自 ctx.sessionMeta 契约字段）。 */
function resolveAgainstProject(path: string, projectPath: string | null): string {
  if (isAbsolutePath(path) || !projectPath) return path;
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return `${projectPath.replace(/[\\/]+$/, "")}${sep}${path.replace(/^[\\/]+/, "")}`;
}

/** 从消息流提取本会话产出/编辑过的 HTML 文件路径（保持出现顺序，后写
 * 覆盖前写——同一路径保留最新位置）。 */
function extractSessionHtmlFiles(messages: PluginMessage[], projectPath: string | null): string[] {
  const seen = new Map<string, true>();
  const ordered: string[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== "tool_use") continue;
      const input = block.input ?? {};
      const raw =
        typeof input.path === "string"
          ? input.path
          : typeof input.file_path === "string"
            ? input.file_path
            : typeof input.filePath === "string"
              ? input.filePath
              : typeof input.file === "string"
                ? input.file
                : null;
      if (!raw || !/\.(html|htm)$/i.test(raw)) continue;
      const normalized = resolveAgainstProject(raw.replace(/\\/g, "/"), projectPath).replace(/\\/g, "/");
      if (!seen.has(normalized)) {
        seen.set(normalized, true);
        ordered.push(normalized);
      } else {
        // 同路径再次写入 → 移到末尾（最新）
        const idx = ordered.indexOf(normalized);
        if (idx >= 0) ordered.splice(idx, 1);
        ordered.push(normalized);
      }
    }
  }
  return ordered;
}

// ── 侧栏面板组件 ──

interface TextFilePreview {
  content: string;
  truncated: boolean;
  size: number;
}

function HtmlPreviewSidebar({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot);
  const candidates = useMemo(
    () => extractSessionHtmlFiles(ctx.messages, ctx.sessionMeta?.projectPath ?? null),
    [ctx.messages, ctx.sessionMeta?.projectPath],
  );
  const current = preview.file;
  // 「本会话产出」竖向列表（标签栏最左按钮 hover/点击展开）。
  const [listHovered, setListHovered] = useState(false);
  // 「...」更多菜单。
  const [menuOpen, setMenuOpen] = useState(false);
  // 已打开的标签（浏览器页签模型）：点选/事件预览自动开签；可单独关闭，
  // 关闭最后一个 = 收起整个侧栏（ctx.closePanel）。
  const [openTabs, setOpenTabs] = useState<string[]>(() => (current ? [current] : []));

  // 当前预览变化 → 确保标签存在。
  useEffect(() => {
    if (preview.file) {
      setOpenTabs((tabs) => (tabs.includes(preview.file!) ? tabs : [...tabs, preview.file!]));
    }
  }, [preview.file]);
  // 无任何预览且无标签 → 默认打开最新产物。
  useEffect(() => {
    if (!preview.file && openTabs.length === 0 && candidates.length > 0) {
      setPreviewFile(candidates[candidates.length - 1]);
    }
  }, [preview.file, openTabs.length, candidates]);

  const closeTab = useCallback(
    (file: string) => {
      const remaining = openTabs.filter((f) => f !== file);
      setOpenTabs(remaining);
      if (file === current) {
        if (remaining.length > 0) setPreviewFile(remaining[remaining.length - 1]);
        else {
          clearPreviewFile();
          ctx.closePanel();
        }
      }
    },
    [openTabs, current, ctx],
  );

  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // 刷新动效：最少转 600ms（读文件太快时肉眼不可见）。
  const [spinning, setSpinning] = useState(false);

  const refresh = useCallback(() => {
    setSpinning(true);
    setRefreshNonce((n) => n + 1);
    window.setTimeout(() => setSpinning(false), 600);
  }, []);

  useEffect(() => {
    if (!current) {
      setContent(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<TextFilePreview>("read_text_file", { path: current })
      .then((result) => {
        if (cancelled) return;
        setContent(result.content);
        setError(
          result.truncated
            ? t("sessionPlugins.htmlPreview.truncated", "文件超过 512KB，预览已截断")
            : null,
        );
      })
      .catch((e) => {
        if (!cancelled) {
          setContent(null);
          setError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [current, preview.version, refreshNonce, t]);

  const openInFolder = useCallback(() => {
    if (current) void invokeCommand("reveal_in_file_manager", { path: current }).catch(console.warn);
    setMenuOpen(false);
  }, [current]);

  const openInBrowser = useCallback(() => {
    if (current) void invokeCommand("open_with_default_app", { path: current }).catch(console.warn);
    setMenuOpen(false);
  }, [current]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 产物标签栏（用户裁决 2026-09-12：左侧清单栏改为上方标签栏）：
          最左「全部产物」按钮 hover 弹竖向列表（产物多/标签溢出时的完整入口），
          其右为文件标签（浏览器页签样式，横向滚动，点击切换、可关闭）。 */}
      <div className="flex h-9 shrink-0 items-stretch gap-0.5 border-b border-border/40 px-1 pt-1">
        <div className="group relative flex items-stretch">
          <button
            type="button"
            title={t("sessionPlugins.htmlPreview.sessionFiles", "本会话产出")}
            className={cn(
              "flex w-8 shrink-0 items-center justify-center rounded-t-md border-x border-t transition-colors",
              listHovered
                ? "border-border/60 bg-muted/60 text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onMouseEnter={() => setListHovered(true)}
            onMouseLeave={() => setListHovered(false)}
            onClick={() => setListHovered((v) => !v)}
          >
            <List className="h-3.5 w-3.5" />
          </button>
          {listHovered && (
            <div
              className="absolute left-0 top-full z-20 w-60 rounded-lg border border-border/70 bg-popover/95 p-1 shadow-lg backdrop-blur"
              onMouseEnter={() => setListHovered(true)}
              onMouseLeave={() => setListHovered(false)}
            >
              <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                {t("sessionPlugins.htmlPreview.sessionFiles", "本会话产出")}
              </div>
              {candidates.length === 0 ? (
                <div className="px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground/60">
                  {t("sessionPlugins.htmlPreview.noFiles", "尚未检测到本会话产出的 HTML 文件")}
                </div>
              ) : (
                candidates.map((file) => {
                  const name = file.split("/").pop() ?? file;
                  const active = file === current;
                  return (
                    <button
                      key={file}
                      type="button"
                      title={file}
                      onClick={() => {
                        setPreviewFile(file);
                        setListHovered(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors",
                        active
                          ? "bg-primary/15 font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <AppWindow className="h-3 w-3 shrink-0 opacity-60" />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
        {/* 文件标签（横向滚动；产物少时即全部，多时配合左端列表） */}
        <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto">
          {openTabs.length === 0 ? (
            <span className="flex items-center px-2 text-[11px] text-muted-foreground/50">
              {t("sessionPlugins.htmlPreview.noFiles", "尚未检测到本会话产出的 HTML 文件")}
            </span>
          ) : (
            openTabs.map((file) => {
              const name = file.split("/").pop() ?? file;
              const active = file === current;
              return (
                <div
                  key={file}
                  className={cn(
                    "group/tab flex max-w-44 shrink-0 items-stretch rounded-t-md border-x border-t transition-colors",
                    active
                      ? "border-border/60 bg-muted/60 font-medium text-foreground"
                      : "border-transparent text-muted-foreground/80 hover:bg-accent/40 hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    title={file}
                    onClick={() => setPreviewFile(file)}
                    className="flex min-w-0 items-center gap-1.5 py-1 pl-2.5 pr-1 text-[11px]"
                  >
                    <AppWindow className="h-3 w-3 shrink-0 opacity-60" />
                    <span className="min-w-0 truncate">{name}</span>
                  </button>
                  <button
                    type="button"
                    title={t("sessionPlugins.htmlPreview.closeTab", "关闭标签")}
                    onClick={() => closeTab(file)}
                    className="flex w-5 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/tab:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
      {/* 渲染区 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/40 px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={current ?? undefined}>
            {current ?? t("sessionPlugins.htmlPreview.empty", "暂无预览")}
          </span>
          <button
            type="button"
            title={t("sessionPlugins.htmlPreview.refresh", "刷新（agent 覆写文件后重读）")}
            disabled={!current}
            onClick={refresh}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <RotateCw className={cn("h-3.5 w-3.5", (spinning || loading) && "animate-spin")} />
          </button>
          {/* 「...」更多菜单：打开文件夹 / 系统浏览器打开 */}
          <div className="relative shrink-0">
            <button
              type="button"
              title={t("sessionPlugins.htmlPreview.more", "更多")}
              disabled={!current}
              onClick={() => setMenuOpen((v) => !v)}
              className={cn(
                "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40",
                menuOpen && "bg-accent text-foreground",
              )}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-border/70 bg-popover/95 p-1 shadow-lg backdrop-blur">
                  <button
                    type="button"
                    onClick={openInFolder}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t("sessionPlugins.htmlPreview.revealFolder", "打开文件夹")}
                  </button>
                  <button
                    type="button"
                    onClick={openInBrowser}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  >
                    <Globe className="h-3.5 w-3.5" />
                    {t("sessionPlugins.htmlPreview.openInBrowser", "使用系统浏览器打开")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        {error && !content ? (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-red-500">
            {error}
          </div>
        ) : (
          <iframe
            // key 强制重载：刷新/事件版本变化时 remount（内容相同也重载页面，
            // 刷新语义可感知）。
            key={`${current ?? "none"}-${preview.version}-${refreshNonce}`}
            title={t("sessionPlugins.htmlPreview.panelTitle", "HTML 预览")}
            sandbox="allow-scripts allow-forms allow-popups"
            srcDoc={content ?? "<!DOCTYPE html><html><body></body></html>"}
            className="min-h-0 w-full flex-1 border-0 bg-white"
          />
        )}
      </div>
    </div>
  );
}

export const htmlPreviewPlugin: SessionPluginDescriptor = {
  id: "session.html-preview",
  displayNameKey: "sessionPlugins.htmlPreview.name",
  displayNameFallback: "HTML 页面预览",
  descriptionKey: "sessionPlugins.htmlPreview.description",
  descriptionFallback:
    "侧边栏渲染 HTML 页面：agent 调 preview_html 自动预览，或手动点选本会话产出的 HTML 文件",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:messages", "panel:open"],
  mounts: [
    {
      // 常驻事件消费：agent 工具的预览请求 → 记录文件 + 展开自己。
      kind: "event-hook",
      onSignal: (signal, ctx) => {
        if (signal.type !== "file-preview-request") return;
        setPreviewFile(signal.file);
        ctx.openPanel("session.html-preview");
      },
    },
    {
      kind: "sidebar-panel",
      titleKey: "sessionPlugins.htmlPreview.panelTitle",
      titleFallback: "HTML 预览",
      Component: HtmlPreviewSidebar,
    },
  ],
};
