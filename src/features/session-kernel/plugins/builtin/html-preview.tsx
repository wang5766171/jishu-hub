/**
 * HTML 页面预览插件（v0.9.2 测试期，用户需求：agent 开发 HTML 后主动在右侧
 * 面板渲染，而非靠 markdown 代码块嵌套）。
 *
 * 数据流：agent 调 preview_html 工具（extensions/html-preview.ts）→ hub_invoke
 * 桥 → 后端校验 + 广播 session-plugin-preview → html-preview-store（模块级
 * 常驻监听）更新 + 请求展开本面板 → 组件读 store，经 read_text_file 读文件
 * 内容以 iframe srcDoc 渲染（sandbox 限权：允许脚本/表单/弹窗，不给同源——
 * 自包含单文件 demo 的交互可用，又不触及 Hub 页面上下文）。
 *
 * 与 session.html-render（markdown 代码块内联渲染）互补：本面板面向
 * 「文件形态的页面产物」，由 agent 决定是否调用（工具描述写明适用场景）。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AppWindow, RotateCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor, SessionKernelContext } from "../types";
import {
  getHtmlPreviewSnapshot,
  subscribeHtmlPreview,
} from "./html-preview-store";

interface TextFilePreview {
  content: string;
  truncated: boolean;
  size: number;
}

function HtmlPreviewPanel(_props: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const preview = useSyncExternalStore(subscribeHtmlPreview, getHtmlPreviewSnapshot);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 本地刷新计数：文件未变但用户手动刷新（agent 覆写后）也强制重读。
  const [refreshNonce, setRefreshNonce] = useState(0);

  const file = preview.file;

  useEffect(() => {
    if (!file) {
      setContent(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<TextFilePreview>("read_text_file", { path: file })
      .then((result) => {
        if (cancelled) return;
        setContent(result.content);
        if (result.truncated) {
          setError(t("sessionPlugins.htmlPreview.truncated", "文件超过 512KB，预览已截断"));
        }
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
  }, [file, preview.version, refreshNonce, t]);

  const refresh = useCallback(() => setRefreshNonce((n) => n + 1), []);

  if (!file) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
        <AppWindow className="h-5 w-5 text-muted-foreground/50" />
        <div>{t("sessionPlugins.htmlPreview.empty", "暂无预览")}</div>
        <div className="text-[11px] leading-relaxed text-muted-foreground/70">
          {t(
            "sessionPlugins.htmlPreview.emptyHint",
            "agent 开发 HTML 页面时可调用 preview_html 工具，在此渲染展示",
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/40 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={file}>
          {file}
        </span>
        <button
          type="button"
          title={t("sessionPlugins.htmlPreview.refresh", "刷新（agent 覆写文件后重读）")}
          onClick={refresh}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RotateCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>
      {error && !content ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-red-500">
          {error}
        </div>
      ) : (
        <iframe
          title={t("sessionPlugins.htmlPreview.panelTitle", "HTML 预览")}
          sandbox="allow-scripts allow-forms allow-popups"
          srcDoc={content ?? "<!DOCTYPE html><html><body></body></html>"}
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
      {error && content ? (
        <div className="shrink-0 border-t border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-600 dark:text-amber-400">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export const htmlPreviewPlugin: SessionPluginDescriptor = {
  id: "session.html-preview",
  displayNameKey: "sessionPlugins.htmlPreview.name",
  displayNameFallback: "HTML 页面预览",
  descriptionKey: "sessionPlugins.htmlPreview.description",
  descriptionFallback: "agent 开发的 HTML 页面在右侧面板渲染预览（preview_html 工具）",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:blocks"],
  mounts: [
    {
      kind: "dock-panel",
      titleKey: "sessionPlugins.htmlPreview.panelTitle",
      titleFallback: "HTML 预览",
      Component: HtmlPreviewPanel,
      defaultSlot: "right",
    },
  ],
};
