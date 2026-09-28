import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Code2, ExternalLink, Eye, Maximize2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor } from "../types";

/**
 * HTML 实时渲染插件（v0.9.2 需求1 M4；v0.9.3 测试期四轮增强）。
 * - 渲染判定：完整文档（<!doctype/</html>）或**含 HTML 标签的片段**（```html
 *   包裹的 <div style> 卡片——用户主场景）；无标签纯文本走普通代码块。
 * - 内联卡（对齐 Mermaid 形态）：**不限高不出滚动条**——srcDoc 注入测量
 *   脚本（ResizeObserver + load/resize + ESC 转发）经 postMessage 上报
 *   （sandbox 跨源可行），iframe 高度跟随内容。
 * - 放大（v0.9.3 测试期重设计）：HTML 会重排、不是图片——全屏+缩放不适用。
 *   改为**宽版阅读器**：Portal 挂 body，居中加宽卡片（≤1100px）。高度语义
 *   （测试期三轮修复后用户裁决终态）：**按内容动态高度**——不超视口时卡片
 *   垂直居中；超出时封顶视口（min(测量高, 100vh-102px)），iframe 内出滚动
 *   条、标题栏常驻。起始高即封顶（vh/百分比布局内容的文档高会镜像 iframe
 *   视口，起始 240 会把这类内容钉死在 240）。ESC（iframe 聚焦后经
 *   postMessage 转发——原父窗口 keydown 收不到 iframe 内按键，「点一下后
 *   ESC 失效」的根因）/ 点空白 / 关闭钮退出。
 * - 视图切换：**单按钮**，图标 = 当前视图（眼睛=卡片 / 代码=源码），点击切换。
 * - 「在新窗口打开」：内容落临时文件经系统默认浏览器打开（后端
 *   open_html_external，沙箱外的完整交互能力）。
 * 边界（v0.9.3 测试期用户确认）：本插件处理**聊天流内代码块**；落盘产出文件
 * 的预览归产物中心（session.artifacts），两者并存非残留。
 */

/** 渲染判定（导出供单测）：完整 HTML 文档，或含任意 HTML 标签的片段。 */
export function isRenderableHtmlBlock(code: string): boolean {
  const lower = code.toLowerCase();
  if (lower.includes("<!doctype html") || lower.includes("</html>")) return true;
  // 片段：形如 <div / </section / <img 等标签起止（后随空白、/> 或 >）。
  return /<\/?[a-z][a-z0-9-]*(\s|\/>|>)/i.test(code);
}

/** iframe → 父窗口消息协议标记。 */
const HEIGHT_MSG_TYPE = "jishu-html-height";
const ESC_MSG_TYPE = "jishu-html-esc";
/** 高度兜底上限（异常内容防御，正常卡片远低于此）。 */
const MAX_HEIGHT_PX = 20000;

/**
 * 注入运行脚本（导出供单测）：高度测量上报 + **ESC 转发**。完整文档插到
 * </body> 前，片段直接追加。sandbox="allow-scripts"（无 allow-same-origin，
 * opaque origin）下与父窗口唯一可信通道是 postMessage——父侧以
 * event.source 过滤来源。ESC 转发是「点击 iframe 后父窗口 keydown 收不到
 * 按键、放大层关不掉」的修复（v0.9.3 测试期）。
 */
/**
 * 注入运行脚本（导出供单测）：**外置同源脚本** `public/jishu-html-harness.js`
 * （高度上报 + ESC 转发）。完整文档插到 </body> 前，片段直接追加。
 * 为何外置而非内联（v0.9.3 测试期 CSP 适配）：srcDoc iframe 继承主 CSP
 * （script-src 'self' 无 'unsafe-inline'），内联脚本在生产包被静默拦截，
 * 高度上报失效卡片停在兜底高度出滚动条（dev 无 CSP 所以表现正常）；
 * 外置同源脚本 'self' 放行，dev/prod 全平台一致。
 * sandbox="allow-scripts"（无 allow-same-origin，opaque origin）下与父窗口
 * 唯一可信通道是 postMessage——父侧以 event.source 过滤来源。
 */
export function injectHeightHarness(code: string): string {
  const harness = `<script src="${window.location.origin}/jishu-html-harness.js"></script>`;
  if (/<\/body>/i.test(code)) {
    return code.replace(/<\/body>/i, `${harness}</body>`);
  }
  return `${code}${harness}`;
}

/** iframe 消息接入：高度上报驱动 state，ESC 转发回调（onEsc 经 ref 保持最新，
 * 不重挂监听）。initialHeight 为上报到达前的起始高：内联卡 240（贴内容）；
 * 放大层传视口封顶高——vh/百分比布局内容的文档高会镜像 iframe 视口，起始
 * 240 会把这类内容钉死在 240（测量值恒等于视口高），起始即满高则自洽。 */
function useIframeMessages(onEsc?: () => void, initialHeight = 240): {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  height: number;
} {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(initialHeight);
  const escRef = useRef(onEsc);
  useEffect(() => {
    escRef.current = onEsc;
  });
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data as { type?: string; height?: number } | null;
      if (!data) return;
      if (
        data.type === HEIGHT_MSG_TYPE &&
        typeof data.height === "number" &&
        Number.isFinite(data.height) &&
        data.height > 0
      ) {
        setHeight(Math.min(Math.ceil(data.height), MAX_HEIGHT_PX));
      } else if (data.type === ESC_MSG_TYPE) {
        escRef.current?.();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return { iframeRef, height };
}

/** 宽版阅读器（Portal 挂 body——消息行 containment 会劫持 fixed 定位基准）。
 * 高度语义（用户裁决终态）：**按内容动态高度**——不超视口 → items-center
 * 垂直居中；超出 → iframe 封顶视口（min(测量高, 100vh-102px)）、iframe 内
 * 滚动（标题栏常驻）。起始高即封顶（防 vh 布局内容被 240 钉死）。
 * 关闭三通道：ESC / 点空白区 / 关闭钮。 */
function HtmlZoomOverlay({ code, onClose }: { code: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { iframeRef, height } = useIframeMessages(
    onClose,
    Math.max(240, window.innerHeight - 102),
  );
  const srcDoc = useMemo(() => injectHeightHarness(code), [code]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const openExternal = useCallback(() => {
    invoke("open_html_external", { html: code }).catch((error) =>
      console.warn("open html externally failed:", error),
    );
  }, [code]);

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" />
      {/* 滚动兜底层：卡片高度已被 iframe 封顶不超视口，此层仅作超小窗口等
          边界兜底；点击空白区关闭（命中滚动容器本身才关，卡片冒泡不关）。 */}
      <div
        className="absolute inset-0 overflow-auto p-4 sm:p-8"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {/* 居中层：min-h-full + items-center——内容矮时卡片垂直居中；卡片高度
            由 iframe 的 min(测量高, 视口封顶) 保证不超视口，故无 flex 居中裁顶
            问题。点击居中层空白（卡片左右两侧）也可关闭。 */}
        <div
          className="mx-auto flex min-h-full w-[min(1100px,100%)] items-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <div className="flex w-full flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
              <span className="text-xs font-medium text-foreground">
                {t("sessionPlugins.htmlRender.zoomTitle", "HTML 放大")}
              </span>
              <button
                type="button"
                title={t("sessionPlugins.htmlRender.openExternal", "在新窗口打开（系统浏览器）")}
                onClick={openExternal}
                className="ml-3 rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
              <span className="ml-auto select-none rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground/70">
                {t("sessionPlugins.htmlRender.escHint", "ESC 关闭")}
              </span>
              <button
                type="button"
                title={t("sessionPlugins.htmlRender.close", "关闭")}
                onClick={onClose}
                className="ml-1.5 rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <iframe
              ref={iframeRef}
              title={t("sessionPlugins.htmlRender.zoomTitle", "HTML 放大")}
              sandbox="allow-scripts allow-forms allow-popups"
              srcDoc={srcDoc}
              /* 动态高度+封顶：102px = 标题栏(h-9=36px) + 上下 padding(p-8=64px)
                 + 卡片上下边框(2px)。内容矮 → iframe=测量高（卡片随内容）；
                 超出 → 封顶视口高、iframe 内出滚动条。CSS min() 原生响应窗口
                 缩放，无需 JS resize 监听。 */
              style={{ height: `min(${height}px, calc(100vh - 102px))` }}
              className="w-full border-0 bg-white"
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function HtmlPreviewCard({ code }: { code: string; language: string }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [expanded, setExpanded] = useState(false);
  const { iframeRef, height } = useIframeMessages();
  const srcDoc = useMemo(() => injectHeightHarness(code), [code]);

  const openExternal = useCallback(() => {
    invoke("open_html_external", { html: code }).catch((error) =>
      console.warn("open html externally failed:", error),
    );
  }, [code]);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/60">
      <div className="flex items-center gap-1 border-b border-border/40 bg-muted/40 px-2 py-1">
        <span className="text-[10px] font-medium text-muted-foreground">
          {t("sessionPlugins.htmlRender.cardTitle", "HTML 渲染")}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {/* v0.9.3 测试期：双视图按钮合一——图标 = 当前视图（眼=卡片/码=源码），
              点击切换视图与图标。 */}
          <button
            type="button"
            title={mode === "preview" ? t("sessionPlugins.htmlRender.source", "源码") : t("sessionPlugins.htmlRender.preview", "预览")}
            onClick={() => setMode((m) => (m === "preview" ? "source" : "preview"))}
            className={cn(
              "rounded p-1 outline-none hover:bg-accent",
              mode === "preview" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {mode === "preview" ? <Eye className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            title={t("sessionPlugins.htmlRender.expand", "放大（宽版阅读器）")}
            disabled={mode !== "preview"}
            onClick={() => setExpanded(true)}
            className="rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={t("sessionPlugins.htmlRender.openExternal", "在新窗口打开（系统浏览器）")}
            onClick={openExternal}
            className="rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {mode === "preview" ? (
        /* 不限高不出滚动条：iframe 高度 = 测量上报的内容高度（对齐 Mermaid
           自然尺寸形态）。 */
        <iframe
          ref={iframeRef}
          title={t("sessionPlugins.htmlRender.previewTitle", "HTML 预览")}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          style={{ height }}
          className="w-full border-0 bg-white"
        />
      ) : (
        <pre className="max-h-96 overflow-auto p-2 text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
      {expanded && <HtmlZoomOverlay code={code} onClose={() => setExpanded(false)} />}
    </div>
  );
}

export const htmlRenderPlugin: SessionPluginDescriptor = {
  id: "session.html-render",
  displayNameKey: "sessionPlugins.htmlRender.name",
  displayNameFallback: "HTML 实时渲染",
  descriptionKey: "sessionPlugins.htmlRender.description",
  descriptionFallback: "消息中的 HTML（完整文档与卡片片段）按内容高度直接渲染",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:blocks"],
  mounts: [
    {
      kind: "block-renderer",
      matching: "code",
      languages: ["html"],
      detect: (_lang, code) => isRenderableHtmlBlock(code),
      Component: HtmlPreviewCard,
    },
  ],
};
