/**
 * 产物中心插件（v0.9.2 测试期；前身为 HTML 页面预览，用户裁决泛化为
 * 「可预览所有类型产物，逻辑交互与 HTML 版一致」）。
 *
 * 双挂载声明（严格插件机制，无内核/页面特判）：
 * - event-hook：常驻消费内核信号 file-preview-request（agent 的 preview_html
 *   等工具经内核事件管线转发）→ 记录当前文件 + ctx.openPanel 展开自己；
 * - sidebar-panel：挤压式侧栏 UI——上方产物标签栏（最左「会话产出」hover
 *   竖向列表）+ 类型分流渲染区。
 *
 * 产物识别：主会话 ctx.messages + 子节点会话（ctx.task.nodeSessions 逐会话
 * 拉取）的 tool_use 路径参数（write/edit 类产物工具；read/grep 类浏览工具
 * 按工具名排除），相对路径以项目根解析。
 *
 * 渲染分流：html→iframe 沙箱；图片→read_image_as_data_url；markdown→
 * ReactMarkdown；其余文本→等宽换行视图；读失败（二进制等）→友好占位
 * （保留打开文件夹/系统打开入口）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, File, FileQuestion, FolderOpen, List, MoreHorizontal, RotateCw, SquareArrowOutUpRight, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "@tauri-apps/api/core";
import { invokeCommand } from "@/hooks/use-invoke";
import { cn } from "@/lib/utils";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor, SessionKernelContext, PluginMessage } from "../types";

// ── 插件私有状态（当前预览文件；event-hook 写入，面板读取）──

interface PreviewState {
  /** 归属会话（null = 无会话上下文/已清空）。v0.9.3 测试期修复：预览状态
   *  按会话作用域——A 会话的 preview_html 不再泄漏到新建/切换的会话
   *  （用户实测：新会话里侧栏自动带着 A 的 HTML 标签与预览）。 */
  sessionKey: string | null;
  file: string | null;
  /** 自增：同一文件再次请求也驱动重载。 */
  version: number;
}

let previewState: PreviewState = { sessionKey: null, file: null, version: 0 };
const previewListeners = new Set<() => void>();

function setPreviewFile(file: string, sessionKey: string | null): void {
  previewState = { sessionKey, file, version: previewState.version + 1 };
  for (const fn of previewListeners) fn();
}

/** 清除当前预览（无选择态；关闭最后一个标签时使用）。 */
function clearPreviewFile(): void {
  previewState = { sessionKey: null, file: null, version: previewState.version + 1 };
  for (const fn of previewListeners) fn();
}

/** 状态对指定会话可见的预览文件（会话不匹配 = 该会话无预览）。 */
function previewFileOf(state: PreviewState, sessionKey: string | null): string | null {
  return state.sessionKey !== null && state.sessionKey === sessionKey ? state.file : null;
}

function getPreviewSnapshot(): PreviewState {
  return previewState;
}

function subscribePreview(cb: () => void): () => void {
  previewListeners.add(cb);
  return () => previewListeners.delete(cb);
}

// ── 产物提取（主会话 PluginMessage 投影 / 子节点原始消息两形共享归一化）──

/** Windows 盘符 / UNC / POSIX 绝对路径判定。 */
function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

/** 相对路径以项目根解析（agent 写文件常用相对路径；projectPath 来自
 * ctx.sessionMeta 契约字段）。 */
function resolveAgainstProject(path: string, projectPath: string | null): string {
  if (isAbsolutePath(path) || !projectPath) return path;
  const sep = projectPath.includes("\\") ? "\\" : "/";
  const rel = path.replace(/^[\\/]*(?:\.{1,2}[\\/]+)+/, "");
  return `${projectPath.replace(/[\\/]+$/, "")}${sep}${rel}`;
}

/** 非产出工具按名称排除——产物口径（用户裁决）：**生成或编辑过的本地
 * 文件**。浏览类（read/find/grep/glob/ls…）只读不产出；引用类
 * （preview/open/reveal…）指向既有文件而非产出；会话内渲染内容
 * （mermaid 流程图等）不经 tool_use 文件参数，天然不在产物源。 */
function isNonProducingTool(name: string | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return /(^|_)(read|find|grep|glob|ls|dir|search|list|watch|head|tail|stat|preview|open|reveal)(_|$)/.test(n)
    || /^(read|find|grep|glob|ls|dir|preview|open|reveal)/.test(n);
}

/** 工具入参里的文件路径参数（write/edit 类工具的 path 形态多样）。 */
function pickPathArg(input: Record<string, unknown>): string | null {
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
  return raw && raw.trim() ? raw : null;
}

/** 归一化（分隔符/相对路径解析）+ 去重（后写覆盖前写，保留最新位置）。 */
function normalizePaths(rawPaths: string[], projectPath: string | null): string[] {
  const seen = new Map<string, true>();
  const ordered: string[] = [];
  for (const raw of rawPaths) {
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
  return ordered;
}

/** 主会话消息（PluginMessage 投影：blocks + text=工具名）产物提取。 */
function extractSessionArtifacts(messages: PluginMessage[], projectPath: string | null): string[] {
  const inputs: string[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== "tool_use") continue;
      if (isNonProducingTool(block.text)) continue;
      const raw = pickPathArg(block.input ?? {});
      if (raw) inputs.push(raw);
    }
  }
  return normalizePaths(inputs, projectPath);
}

/** 子节点会话消息（get_session_messages 原始形状）的产物提取——任务执行
 * 的实际写文件方是节点子代理，主会话视角也要能识别其产物。导出供单测。 */
export function extractArtifactPathsFromRawMessages(
  messages: Array<{ content?: Array<{ type?: string; name?: string; input?: unknown }> }>,
  projectPath: string | null,
): string[] {
  const inputs: string[] = [];
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block?.type !== "tool_use") continue;
      if (isNonProducingTool(block.name)) continue;
      const raw = pickPathArg(
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {},
      );
      if (raw) inputs.push(raw);
    }
  }
  return normalizePaths(inputs, projectPath);
}

// ── 类型分流 ──

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
const HTML_EXT = /\.(html?|xhtml)$/i;

type ArtifactKind = "html" | "image" | "markdown" | "text";

function artifactKind(file: string): ArtifactKind {
  if (HTML_EXT.test(file)) return "html";
  if (IMAGE_EXT.test(file)) return "image";
  if (MARKDOWN_EXT.test(file)) return "markdown";
  return "text";
}

// ── 侧栏面板组件 ──

interface TextFilePreview {
  content: string;
  truncated: boolean;
  size: number;
}

interface LoadedArtifact {
  kind: ArtifactKind;
  /** text/markdown/html：文本内容。 */
  content: string | null;
  /** image：data URL。 */
  dataUrl: string | null;
  truncated: boolean;
}

function ArtifactsSidebar({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot);
  const sessionId = ctx.sessionId;
  const projectPath = ctx.sessionMeta?.projectPath ?? null;
  const mainFiles = useMemo(
    () => extractSessionArtifacts(ctx.messages, projectPath),
    [ctx.messages, projectPath],
  );

  // v0.9.3 测试期修复：预览/标签按会话作用域。current 只取「归属当前会话」
  // 的预览（切回原会话时其预览自然恢复）。
  const current = previewFileOf(preview, sessionId);

  // 子节点会话产物：经 ctx.task.nodeSessions 索引逐会话拉取；刷新时重扫。
  const nodeSessions = ctx.task?.nodeSessions ?? [];
  const nodeSessionsKey = useMemo(
    () => nodeSessions.map((n) => `${n.nodeId}:${n.sessionId ?? ""}`).join("|"),
    [nodeSessions],
  );
  const [nodeArtifacts, setNodeArtifacts] = useState<Array<{ file: string; source: string }>>([]);
  const [rescanNonce, setRescanNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const encoded = ctx.sessionMeta?.projectEncodedName;
    if (!encoded || nodeSessions.length === 0) {
      setNodeArtifacts([]);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      const results = await Promise.all(
        nodeSessions.map(async (ns) => {
          if (!ns.sessionId) return [] as Array<{ file: string; source: string }>;
          try {
            const msgs = await invoke<
              Array<{ content?: Array<{ type?: string; name?: string; input?: unknown }> }>
            >("get_session_messages", {
              agentId: ns.agentId ?? "",
              sessionId: ns.sessionId,
              encodedName: encoded,
            });
            return extractArtifactPathsFromRawMessages(msgs, projectPath).map((file) => ({
              file,
              source: ns.title,
            }));
          } catch {
            return [] as Array<{ file: string; source: string }>;
          }
        }),
      );
      if (!cancelled) setNodeArtifacts(results.flat());
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeSessionsKey, rescanNonce, ctx.sessionMeta?.projectEncodedName, projectPath]);

  // 合并候选（主会话 + 各节点）：同文件以节点为准（实际写方），保序去重。
  const candidates = useMemo(() => {
    const byFile = new Map<string, { file: string; source: string | null }>();
    for (const file of mainFiles) byFile.set(file, { file, source: null });
    for (const item of nodeArtifacts) byFile.set(item.file, { file: item.file, source: item.source });
    return Array.from(byFile.values());
  }, [mainFiles, nodeArtifacts]);

  // 「会话产出」竖向列表（标签栏最左按钮 hover/点击展开）。
  const [listHovered, setListHovered] = useState(false);
  // 「...」更多菜单。
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // 已打开的标签（浏览器页签模型）：点选/事件预览自动开签；可单独关闭，
  // 关闭最后一个 = 收起整个侧栏（ctx.closePanel）。
  const [openTabs, setOpenTabs] = useState<string[]>(() => (current ? [current] : []));

  // v0.9.3 测试期修复（跨会话泄漏 + 空会话可开面板）：会话切换 → 标签栏
  // 归位本会话；本会话无任何产物与预览时收起侧栏（A 会话 preview_html 自动
  // 展开的侧栏不跟进新会话）。**首挂载跳过**（ref 初值 = 当前会话）：空会话
  // 里用户主动点开产物中心是正常操作，不能挂载即收起——否则面板表现为
  // 「点了没反应」（开着瞬间被关）。
  const prevSessionRef = useRef<string | null>(sessionId);
  useEffect(() => {
    const switched = prevSessionRef.current !== sessionId;
    prevSessionRef.current = sessionId;
    if (!switched) return;
    setOpenTabs(current ? [current] : []);
    if (!current && mainFiles.length === 0 && nodeArtifacts.length === 0) {
      ctx.closePanel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 当前预览变化 → 确保标签存在。
  useEffect(() => {
    if (current) {
      setOpenTabs((tabs) => (tabs.includes(current) ? tabs : [...tabs, current]));
    }
  }, [current]);
  // 无任何预览且无标签 → 默认打开最新产物。
  useEffect(() => {
    if (!current && openTabs.length === 0 && candidates.length > 0) {
      setPreviewFile(candidates[candidates.length - 1].file, sessionId);
    }
  }, [current, openTabs.length, candidates, sessionId]);

  const closeTab = useCallback(
    (file: string) => {
      const remaining = openTabs.filter((f) => f !== file);
      setOpenTabs(remaining);
      if (file === current) {
        if (remaining.length > 0) setPreviewFile(remaining[remaining.length - 1], sessionId);
        else {
          clearPreviewFile();
          ctx.closePanel();
        }
      }
    },
    [openTabs, current, ctx, sessionId],
  );

  // 内容加载：按类型分流（图片 data URL / 文本 read_text_file）。
  const [loaded, setLoaded] = useState<LoadedArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // 刷新动效：最少转 600ms（读文件太快时肉眼不可见）。
  const [spinning, setSpinning] = useState(false);

  const refresh = useCallback(() => {
    setSpinning(true);
    setRefreshNonce((n) => n + 1);
    // 刷新同时重扫子节点会话产物（节点执行中会持续写新文件）。
    setRescanNonce((n) => n + 1);
    window.setTimeout(() => setSpinning(false), 600);
  }, []);

  const kind = current ? artifactKind(current) : null;
  useEffect(() => {
    if (!current || !kind) {
      setLoaded(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (kind === "image") {
      invokeCommand<string>("read_image_as_data_url", { path: current })
        .then((dataUrl) => {
          if (!cancelled) setLoaded({ kind, content: null, dataUrl, truncated: false });
        })
        .catch((e) => {
          if (!cancelled) {
            setLoaded(null);
            setError(String(e));
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    } else {
      invoke<TextFilePreview>("read_text_file", { path: current })
        .then((result) => {
          if (!cancelled) {
            setLoaded({ kind, content: result.content, dataUrl: null, truncated: result.truncated });
            setError(
              result.truncated
                ? t("sessionPlugins.artifacts.truncated", "文件超过 512KB，预览已截断")
                : null,
            );
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setLoaded(null);
            setError(String(e));
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [current, kind, preview.version, refreshNonce, t]);

  const openInFolder = useCallback(() => {
    setMenuOpen(false);
    if (!current) return;
    // v0.9.3 测试期：打开失败必须可见——此前 catch(console.warn) 静默吞错，
    // 公司环境点击「打开文件夹没反应」即此（真实失败原因被吞）。
    invokeCommand("reveal_in_file_manager", { path: current }).catch((e) => {
      const msg = String(e);
      console.warn("reveal_in_file_manager failed:", msg);
      setActionError(msg.length > 160 ? `${msg.slice(0, 160)}…` : msg);
    });
  }, [current]);

  const openInSystem = useCallback(() => {
    setMenuOpen(false);
    if (!current) return;
    invokeCommand("open_with_default_app", { path: current }).catch((e) => {
      const msg = String(e);
      console.warn("open_with_default_app failed:", msg);
      setActionError(msg.length > 160 ? `${msg.slice(0, 160)}…` : msg);
    });
  }, [current]);

  // 动作错误 5s 自动消散（不打断工作流）。
  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), 5000);
    return () => clearTimeout(timer);
  }, [actionError]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 产物标签栏：最左「会话产出」按钮 hover 弹竖向列表（产物多/标签溢出
          时的完整入口），其右为文件标签（浏览器页签样式，横向滚动，点击
          切换、可关闭）。 */}
      <div className="flex h-9 shrink-0 items-stretch gap-0.5 border-b border-border/40 px-1 pt-1">
        <div className="group relative flex items-stretch">
          <button
            type="button"
            title={t("sessionPlugins.artifacts.sessionFiles", "会话产出")}
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
                {t("sessionPlugins.artifacts.sessionFiles", "会话产出")}
              </div>
              {candidates.length === 0 ? (
                <div className="px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground/60">
                  {t("sessionPlugins.artifacts.noFiles", "尚未检测到本会话的产物文件")}
                </div>
              ) : (
                candidates.map(({ file, source }) => {
                  const name = file.split("/").pop() ?? file;
                  const active = file === current;
                  return (
                    <button
                      key={file}
                      type="button"
                      title={file}
                      onClick={() => {
                        setPreviewFile(file, sessionId);
                        setListHovered(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors",
                        active
                          ? "bg-primary/15 font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <File className="h-3 w-3 shrink-0 opacity-60" />
                      <span className="min-w-0 flex-1 truncate">
                        {name}
                        {source ? (
                          <span className="ml-1 text-[9px] font-normal text-muted-foreground/60">
                            {source}
                          </span>
                        ) : null}
                      </span>
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
              {t("sessionPlugins.artifacts.noFiles", "尚未检测到本会话的产物文件")}
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
                    onClick={() => setPreviewFile(file, sessionId)}
                    className="flex min-w-0 items-center gap-1.5 py-1 pl-2.5 pr-1 text-[11px]"
                  >
                    <File className="h-3 w-3 shrink-0 opacity-60" />
                    <span className="min-w-0 truncate">{name}</span>
                  </button>
                  <button
                    type="button"
                    title={t("sessionPlugins.artifacts.closeTab", "关闭标签")}
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
      {/* 渲染区：按类型分流 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/40 px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={current ?? undefined}>
            {current ?? t("sessionPlugins.artifacts.empty", "暂无预览")}
          </span>
          <button
            type="button"
            title={t("sessionPlugins.artifacts.refresh", "刷新（agent 覆写文件后重读）")}
            disabled={!current}
            onClick={refresh}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <RotateCw className={cn("h-3.5 w-3.5", (spinning || loading) && "animate-spin")} />
          </button>
          {/* 「...」更多菜单：打开文件夹 / 系统默认应用打开 */}
          <div className="relative shrink-0">
            <button
              type="button"
              title={t("sessionPlugins.artifacts.more", "更多")}
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
                    {t("sessionPlugins.artifacts.revealFolder", "打开文件夹")}
                  </button>
                  <button
                    type="button"
                    onClick={openInSystem}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  >
                    <SquareArrowOutUpRight className="h-3.5 w-3.5" />
                    {t("sessionPlugins.artifacts.openInSystem", "使用系统默认应用打开")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        {/* 打开文件夹/系统打开失败 → 全局弹窗（v0.9.3 测试期：此前静默吞错，
            公司环境「点击没反应」无从排查；弹窗直接呈现后端真实错误，Portal
            挂 body 规避侧栏 containment 裁剪）。 */}
        {actionError
          ? createPortal(
              <div
                className="fixed inset-x-0 top-4 z-[70] flex justify-center px-4"
                onClick={() => setActionError(null)}
              >
                <div
                  role="alert"
                  className="pointer-events-auto flex max-w-xl items-start gap-2 rounded-lg border border-red-500/50 bg-popover/95 px-3 py-2 shadow-xl backdrop-blur"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                  <div className="min-w-0 text-xs">
                    <div className="font-medium text-red-600 dark:text-red-300">
                      {t("sessionPlugins.artifacts.openFailed", "打开失败")}
                    </div>
                    <div className="break-all text-muted-foreground">{actionError}</div>
                  </div>
                  <button
                    type="button"
                    title={t("sessionPlugins.artifacts.closeTab", "关闭")}
                    onClick={() => setActionError(null)}
                    className="ml-1 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>,
              document.body,
            )
          : null}
        {error && !loaded ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <FileQuestion className="h-6 w-6 text-muted-foreground/40" />
            <div className="text-xs text-muted-foreground">
              {t("sessionPlugins.artifacts.unsupported", "该文件暂不支持预览（可经「...」用系统默认应用打开）")}
            </div>
            <div className="max-w-full truncate text-[10px] text-muted-foreground/60" title={error}>
              {error}
            </div>
          </div>
        ) : loaded?.kind === "html" && loaded.content != null ? (
          <iframe
            key={`${current}-${preview.version}-${refreshNonce}`}
            title={t("sessionPlugins.artifacts.panelTitle", "产物中心")}
            sandbox="allow-scripts allow-forms allow-popups"
            srcDoc={loaded.content}
            className="min-h-0 w-full flex-1 border-0 bg-white"
          />
        ) : loaded?.kind === "image" && loaded.dataUrl ? (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-3">
            {/* key 强制重载（刷新语义可感知）。 */}
            <img
              key={`${current}-${preview.version}-${refreshNonce}`}
              src={loaded.dataUrl}
              alt={current ?? ""}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : loaded?.kind === "markdown" && loaded.content != null ? (
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            <div className="markdown-prose" key={`${current}-${preview.version}-${refreshNonce}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{loaded.content}</ReactMarkdown>
            </div>
          </div>
        ) : loaded?.content != null ? (
          <pre
            key={`${current}-${preview.version}-${refreshNonce}`}
            className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-foreground/85"
          >
            {loaded.content}
          </pre>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
            {loading
              ? t("sessionPlugins.artifacts.loading", "读取中…")
              : t("sessionPlugins.artifacts.empty", "暂无预览")}
          </div>
        )}
        {error && loaded ? (
          <div className="shrink-0 border-t border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[10px] text-amber-600 dark:text-amber-400">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const artifactsPlugin: SessionPluginDescriptor = {
  id: "session.artifacts",
  displayNameKey: "sessionPlugins.artifacts.name",
  displayNameFallback: "产物中心",
  descriptionKey: "sessionPlugins.artifacts.description",
  descriptionFallback:
    "侧边栏预览会话产物（HTML/图片/Markdown/文本）：agent 调 preview_html 自动预览，或手动点选主会话与子节点产出",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:messages", "panel:open"],
  mounts: [
    {
      // 常驻事件消费：agent 工具的预览请求 → 记录文件（归属信号来源会话，
      // v0.9.3 测试期修复跨会话泄漏）+ 展开自己。
      kind: "event-hook",
      onSignal: (signal, ctx) => {
        if (signal.type !== "file-preview-request") return;
        setPreviewFile(signal.file, signal.sessionId ?? ctx.sessionId);
        ctx.openPanel("session.artifacts");
      },
    },
    {
      kind: "sidebar-panel",
      titleKey: "sessionPlugins.artifacts.panelTitle",
      titleFallback: "产物中心",
      Component: ArtifactsSidebar,
    },
  ],
};
