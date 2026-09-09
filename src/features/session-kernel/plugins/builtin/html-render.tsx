import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Code2, Eye, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor } from "../types";

/**
 * HTML 实时渲染插件（v0.9.2 需求1 M4，用户圈定首期 #1）。
 * 完整 HTML 文档代码块 → 沙箱 iframe 预览卡（预览/源码切换、放大）；
 * 沙箱禁脚本外联网络（allow-scripts 本地交互 + 禁同源/外站跳转）。
 * 流式期间不走此渲染（streaming-message 无渲染器咨询点），块完整后切换。
 */

function isCompleteHtmlDocument(code: string): boolean {
  const lower = code.toLowerCase();
  return lower.includes("<!doctype html") || lower.includes("</html>");
}

function HtmlPreviewCard({ code }: { code: string; language: string }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [expanded, setExpanded] = useState(false);
  const iframe = useMemo(
    () => (
      <iframe
        title={t("sessionPlugins.htmlRender.previewTitle", "HTML 预览")}
        sandbox="allow-scripts"
        srcDoc={code}
        className="h-full w-full border-0 bg-white"
      />
    ),
    [code, t],
  );
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/60">
      <div className="flex items-center gap-1 border-b border-border/40 bg-muted/40 px-2 py-1">
        <span className="text-[10px] font-medium text-muted-foreground">
          {t("sessionPlugins.htmlRender.cardTitle", "HTML 渲染")}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            title={t("sessionPlugins.htmlRender.preview", "预览")}
            onClick={() => setMode("preview")}
            className={cn(
              "rounded p-1 hover:bg-accent",
              mode === "preview" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={t("sessionPlugins.htmlRender.source", "源码")}
            onClick={() => setMode("source")}
            className={cn(
              "rounded p-1 hover:bg-accent",
              mode === "source" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Code2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={t("sessionPlugins.htmlRender.expand", "放大")}
            onClick={() => setExpanded((v) => !v)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      {mode === "preview" ? (
        <div className={cn("w-full", expanded ? "fixed inset-8 z-50 rounded-lg bg-background shadow-2xl" : "h-72")}>
          {iframe}
        </div>
      ) : (
        <pre className="max-h-72 overflow-auto p-2 text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

export const htmlRenderPlugin: SessionPluginDescriptor = {
  id: "session.html-render",
  displayNameKey: "sessionPlugins.htmlRender.name",
  displayNameFallback: "HTML 实时渲染",
  descriptionKey: "sessionPlugins.htmlRender.description",
  descriptionFallback: "消息中的完整 HTML 文档直接渲染预览",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:blocks"],
  mounts: [
    {
      kind: "block-renderer",
      languages: ["html"],
      detect: (_lang, code) => isCompleteHtmlDocument(code),
      Component: HtmlPreviewCard,
    },
  ],
};
