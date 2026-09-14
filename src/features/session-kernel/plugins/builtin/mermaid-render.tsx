/**
 * Mermaid/图表渲染插件（v0.9.2 需求1 M4；2026-09-12 二轮增强）。
 *
 * 渲染：mermaid 代码块 → SVG；失败回退源码（fail-soft）。按自然尺寸渲染
 * （解除 mermaid 默认 max-width:100% 压缩），容器横向滚动。
 *
 * 放大：全屏查看器，真缩放（滚轮以光标为中心缩放、+/-/适配宽度按钮、
 * 拖拽平移、双击复位）——一轮的"悬浮不放大"已废。
 *
 * 导出（PNG 2x 白底 / SVG）：关键在 mermaid 流程图默认 htmlLabels=true，
 * 标签是 foreignObject(HTML)——SVG 经 <img> 栅格化时 Chromium 不绘制
 * foreignObject（导出图"有框无字"的根因），且 width="100%" 的根属性会让
 * 部分图 img 加载直接失败（"SVG rasterize failed"）。导出前以
 * htmlLabels=false 重渲染出纯 <text> 标签版本，并补齐 xmlns 与显式宽高。
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { FileCode2, ImageDown, Minus, Plus, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor } from "../types";

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;

async function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => {
      mod.default.initialize({ startOnLoad: false, securityLevel: "strict" });
      return mod.default;
    });
  }
  return mermaidReady;
}

/** v0.9.3 需求6：暗色主题跟随——documentElement.dark 类监听（应用主题切换
 *  即时生效），mermaid 以当前主题渲染；主题变化由组件层触发重渲染。 */
function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

// ── 导出/渲染规范化工具（纯正则字符串手术，有单测）──
// 不用 DOMParser：mermaid 的 foreignObject 标签内含未闭合 <br> 等非良构
// XML，XML 模式解析直接产出 parsererror 垃圾串。

export interface ExportSvg {
  svg: string;
  width: number;
  height: number;
}

/** 从 mermaid SVG 字符串解析视口尺寸（正则取 viewBox，回退显式像素属性）。 */
export function parseSvgSize(svg: string): { width: number; height: number } {
  const vb =
    /viewBox\s*=\s*"([\d.eE+-]+)[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)"/.exec(svg);
  if (vb) {
    const w = parseFloat(vb[3]);
    const h = parseFloat(vb[4]);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  const w = parseFloat(/\swidth\s*=\s*"([\d.]+)"/.exec(svg)?.[1] ?? "");
  const h = parseFloat(/\sheight\s*=\s*"([\d.]+)"/.exec(svg)?.[1] ?? "");
  if (w > 0 && h > 0) return { width: w, height: h };
  return { width: 800, height: 600 };
}

/**
 * 导出/渲染规范化：按 viewBox 写死显式像素宽高（mermaid 根节点
 * width="100%" 无固有尺寸——纯 CSS 在块容器拉伸、flex 容器塌陷），剥根
 * style（max-width），补 xmlns（独立打开/栅格化前提）。非 SVG 输入原样返回。
 */
export function buildExportSvg(source: string): ExportSvg {
  const m = /<svg\b[^>]*>/i.exec(source);
  if (!m) return { svg: source, width: 800, height: 600 };
  const { width, height } = parseSvgSize(source);
  const w = Math.round(width);
  const h = Math.round(height);
  let tag = m[0]
    .replace(/\swidth\s*=\s*"[^"]*"/i, "")
    .replace(/\sheight\s*=\s*"[^"]*"/i, "")
    .replace(/\sstyle\s*=\s*"[^"]*"/i, "");
  if (!/xmlns\s*=/.test(tag)) {
    tag = tag.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  tag = tag.replace(/^<svg\b/i, `<svg width="${w}" height="${h}"`);
  return { svg: source.replace(m[0], tag), width: w, height: h };
}

/** XML 文本转义（foreignObject 文本提取后回填 <text> 用）。 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * foreignObject(HTML) 标签 → 居中 SVG <text>（仅导出管线使用）。
 *
 * 背景：mermaid htmlLabels 默认 true 且 %%{init}%% 指令关不掉（v11.17
 * 实测节点/边标签仍为 foreignObject）。后果两条：① foreignObject 内含未
 * 闭合 <br> → 整个 SVG 非良构 XML → <img> 拒载（PNG「SVG rasterize
 * failed」）；② 外部查看器/栅格化不绘制 foreignObject（导出图缺标签）。
 * 转成 <text> 后两条皆除。定位：foreignObject 常无 x/y（父 <g> transform
 * 定位），以自身 width/height 中心放置；<br> 拆多行 tspan。
 */
export function foreignObjectsToText(source: string): string {
  return source.replace(
    /<foreignObject\b([^>]*)>([\s\S]*?)<\/foreignObject>/gi,
    (_match, attrs: string, inner: string) => {
      const num = (name: string): number => {
        const found = new RegExp(`\\s${name}\\s*=\\s*"(-?[\\d.]+)"`).exec(attrs);
        return found ? parseFloat(found[1]) : 0;
      };
      const w = num("width") || 100;
      const h = num("height") || 20;
      const cx = num("x") + w / 2;
      const cy = num("y") + h / 2;
      const text = inner
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/[ \t]+/g, " ")
        .trim();
      if (!text) return "";
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      const lh = 1.25;
      const startDy = -((lines.length - 1) * lh) / 2;
      const spans = lines
        .map((line) => escapeXml(line))
        .map((line, i) =>
          i === 0
            ? `<tspan x="${cx}" dy="${startDy}em">${line}</tspan>`
            : `<tspan x="${cx}" dy="${lh}em">${line}</tspan>`,
        )
        .join("");
      return `<text class="edgeLabel" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" fill="#333">${spans}</text>`;
    },
  );
}

/**
 * 栅格化前良构化（官方 mermaid-live-editor Actions.svelte 同款字符串手术）：
 * 未闭合 <br> / <img> 是 SVG 经 <img> 加载失败的根因（XML 解析拒绝），
 * 自闭合后 Chromium 的 SVG-image 路径即可原生渲染 foreignObject 标签。
 */
export function wellFormSvgXml(source: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${source
    .replace(/<br\s*(?!\/)>/gi, "<br/>")
    .replace(/<img\b([^>]*?)\/?>/gi, "<img$1/>")}`;
}

/** UTF-8 字符串 → base64（中文标签必需；分块避免栈溢出）。 */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** SVG 字符串 → PNG Blob（官方 live editor 管线：良构化 → data URL（非
 * blob URL，跨引擎 drawImage 兼容）→ Image → canvas 2x 白底 → toBlob。
 * 不转 foreignObject——良构 XML 下 Chromium 原生渲染 HTML 标签）。 */
async function svgToPngBlob(source: string, scale = 2): Promise<Blob> {
  const { svg, width, height } = buildExportSvg(source);
  const dataUrl = `data:image/svg+xml;base64,${utf8ToBase64(wellFormSvgXml(svg))}`;
  const img = new Image();
  img.width = width;
  img.height = height;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("SVG rasterize failed"));
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── 组件 ──

interface ExportHandlers {
  onExportPng: () => void;
  onExportSvg: () => void;
  exporting: boolean;
}

function ExportButtons({ handlers, className }: { handlers: ExportHandlers; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <button
        type="button"
        title={t("sessionPlugins.mermaidRender.exportPng", "导出 PNG")}
        disabled={handlers.exporting}
        onClick={handlers.onExportPng}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        <ImageDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title={t("sessionPlugins.mermaidRender.exportSvg", "导出 SVG")}
        disabled={handlers.exporting}
        onClick={handlers.onExportSvg}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        <FileCode2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** SVG 宿主——图已带显式像素宽高（渲染期 buildExportSvg 规范化），此处仅
 * 上限收窄（max-w-full + h-auto 保持比例）与居中，不拉伸。 */
function SvgHost({ svg }: { svg: string }) {
  return (
    <div
      className="mermaid-svg-host [&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full"
      // mermaid securityLevel=strict 产物已转义脚本注入面
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

const MIN_SCALE = 0.15;
const MAX_SCALE = 6;
/** 内联（会话中）初始缩放：自然尺寸的 50%（用户裁决 2026-09-12）。 */
const INLINE_SCALE = 0.5;

/** 全屏缩放查看器：滚轮缩放、拖拽平移（指针捕获在稳定容器上，捕获丢失/
 * 取消即结束拖拽——此前捕获挂在会被重渲替换的 svg 子元素上，偶发
 * pointerup 丢失导致"小手粘住"）、双击适配宽度、ESC/点遮罩关闭。 */
function MermaidZoomOverlay({
  svg,
  onClose,
  exportHandlers,
}: {
  svg: string;
  onClose: () => void;
  exportHandlers: ExportHandlers;
}) {
  const { t } = useTranslation();
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const areaRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ id: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** v0.9.3 测试期修复：适屏（宽高 contain，封顶 1x）——超大图按宽适配仍会
   *  高度溢出、居中布局把顶部顶出屏幕外；打开即适屏 + 「适配」/双击统一走
   *  本语义，保证内容顶部始终可见。 */
  const fitContain = useCallback(() => {
    const area = areaRef.current;
    const stage = stageRef.current;
    if (!area || !stage) return;
    const svgEl = stage.querySelector("svg");
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const cur = Math.max(scale, 0.0001);
    const naturalW = rect.width / cur;
    const naturalH = rect.height / cur;
    const target = Math.min(
      (area.clientWidth - 32) / (naturalW || area.clientWidth),
      (area.clientHeight - 32) / (naturalH || area.clientHeight),
      1,
    );
    setScale(Math.min(Math.max(target, MIN_SCALE), MAX_SCALE));
    setPan({ x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, svg]);

  // 打开（挂载）即适屏：初始 scale=1 时超大图顶部顶出屏幕的缺陷修复。
  useEffect(() => {
    fitContain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svg]);

  // 滚轮缩放（原生监听，passive:false 才能 preventDefault）。
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale((prev) => {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        return Math.min(Math.max(prev * factor, MIN_SCALE), MAX_SCALE);
      });
    };
    area.addEventListener("wheel", onWheel, { passive: false });
    return () => area.removeEventListener("wheel", onWheel);
  }, []);

  const endDrag = useCallback(() => {
    dragState.current = null;
    setDragging(false);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // 捕获在稳定的容器（currentTarget）上：子元素（svg）随 pan/缩放重渲
    // 替换，捕获其上会在拖拽中静默丢失 → pointerup 无处送达 → 小手粘住。
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: pan.x,
      baseY: pan.y,
    };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = dragState.current;
    if (!s || s.id !== e.pointerId) return;
    setPan({ x: s.baseX + (e.clientX - s.startX), y: s.baseY + (e.clientY - s.startY) });
  };

  return (
    // 遮罩层：暗化背景与弹窗形成分界（用户裁决：关闭统一走 ESC/关闭钮，
    // 不做点击空白关闭——消息区层叠上下文内 fixed 遮罩无法可靠覆盖全窗口）。
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" />
      <div className="absolute inset-4 flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl sm:inset-6">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          <span className="text-xs font-medium text-foreground">
            {t("sessionPlugins.mermaidRender.zoomTitle", "图表放大")}
          </span>
          <div className="ml-3 flex items-center gap-0.5">
            <button
              type="button"
              title={t("sessionPlugins.mermaidRender.zoomOut", "缩小")}
              onClick={() => setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s / 1.25)))}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="w-11 select-none text-center text-[11px] tabular-nums text-muted-foreground">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              title={t("sessionPlugins.mermaidRender.zoomIn", "放大")}
              onClick={() => setScale((s) => Math.min(MAX_SCALE, s * 1.25))}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title={t("sessionPlugins.mermaidRender.fitWidth", "适配屏幕")}
              onClick={fitContain}
              className="ml-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {t("sessionPlugins.mermaidRender.fitWidth", "适配")}
            </button>
          </div>
          <ExportButtons handlers={exportHandlers} className="ml-3" />
          <span className="ml-auto select-none rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground/70">
            {t("sessionPlugins.mermaidRender.escHint", "ESC 关闭")}
          </span>
          <button
            type="button"
            title={t("sessionPlugins.mermaidRender.close", "关闭")}
            onClick={onClose}
            className="ml-1.5 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div
          ref={areaRef}
          className={cn(
            "flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden bg-muted/10",
            dragging ? "cursor-grabbing" : "cursor-grab",
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={fitContain}
        >
          <div
            ref={stageRef}
            className="select-none p-4"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
          >
            <SvgHost svg={svg} />
          </div>
        </div>
      </div>
    </div>
  );
}

function MermaidDiagram({ code }: { code: string; language: string }) {
  const { t } = useTranslation();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const dark = useIsDarkTheme();
  const idRef = useRef(`mmd-${useId().replace(/[^a-zA-Z0-9]/g, "")}`);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setSvg(null);
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        // v0.9.3 需求6：主题跟随——initialize 幂等，切主题重渲（deps 含 dark）。
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "default",
        });
        const { svg: raw } = await mermaid.render(idRef.current, code);
        if (cancelled) return;
        // 渲染期规范化（同导出管线）：mermaid 根节点 width="100%" 且无固有
        // 宽高——纯 CSS（w-auto）在块容器中退化为拉伸、在 flex 容器中塌陷
        // （放大白屏的根因）。按 viewBox 写死显式像素宽高并剥 style，CSS 仅
        // 负责上限收窄（max-w-full + h-auto）。
        setSvg(buildExportSvg(raw).svg);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, dark]);

  const exportPng = useCallback(async () => {
    if (!svg || exporting) return;
    setExporting(true);
    try {
      const blob = await svgToPngBlob(svg, 2);
      const path = await save({
        defaultPath: "mermaid.png",
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!path) return;
      await invoke("export_binary_file", { path, base64Data: await blobToBase64(blob) });
      setExportError(null);
    } catch (e) {
      setExportError(String(e));
    } finally {
      setExporting(false);
    }
  }, [svg, exporting]);

  const exportSvgFile = useCallback(async () => {
    if (!svg || exporting) return;
    setExporting(true);
    try {
      const path = await save({
        defaultPath: "mermaid.svg",
        filters: [{ name: "SVG", extensions: ["svg"] }],
      });
      if (!path) return;
      await invoke("export_text_file", {
        path,
        // SVG 文件：foreignObject→text（外部查看器普遍不渲染 foreignObject，
        // draw.io 文档确认的标准解）+ 良构化（自闭合标签 + XML 声明）。
        content: wellFormSvgXml(foreignObjectsToText(buildExportSvg(svg).svg)),
      });
      setExportError(null);
    } catch (e) {
      setExportError(String(e));
    } finally {
      setExporting(false);
    }
  }, [svg, exporting]);

  const exportHandlers: ExportHandlers = { onExportPng: () => void exportPng(), onExportSvg: () => void exportSvgFile(), exporting };

  if (failed) {
    return (
      <pre className="my-2 overflow-auto rounded-lg border border-border/60 p-2 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/60 bg-muted/20">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border/40 px-1.5 py-1">
        <ExportButtons handlers={exportHandlers} />
      </div>
      <div className="flex justify-center p-2">
        {/* 内联初始 50% 自然尺寸（用户裁决）：宽度 = 自然宽 × 0.5，上限栏宽
            （超宽图进一步收窄），高度随图自适应——卡片自身不出滚动条。
            放大入口：图区域 cursor-zoom-in，单击打开查看器（无需找图标）。 */}
        {svg ? (
          <div
            className="max-w-full cursor-zoom-in"
            style={{ width: Math.round(parseSvgSize(svg).width * INLINE_SCALE) }}
            title={t("sessionPlugins.mermaidRender.clickToZoom", "点击放大")}
            onClick={() => setExpanded(true)}
          >
            <SvgHost svg={svg} />
          </div>
        ) : (
          <div className="py-6 text-center text-xs text-muted-foreground">
            {t("sessionPlugins.mermaidRender.rendering", "图表渲染中…")}
          </div>
        )}
      </div>
      {exportError ? (
        <div className="border-t border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-600 dark:text-red-300">
          {t("sessionPlugins.mermaidRender.exportFailed", "导出失败")}：{exportError}
        </div>
      ) : null}
      {/* v0.9.3 测试期修复：放大层经 Portal 挂 document.body——消息行的
          containment 会劫持 fixed 的定位基准（等效相对整个滚动内容区定位），
          图在会话底部时放大层顶部被顶出屏幕、看不到头上内容。脱离消息树后
          fixed 恢复真视口定位，与滚动位置解耦。 */}
      {expanded && svg
        ? createPortal(
            <MermaidZoomOverlay
              svg={svg}
              onClose={() => setExpanded(false)}
              exportHandlers={exportHandlers}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

export const mermaidRenderPlugin: SessionPluginDescriptor = {
  id: "session.mermaid-render",
  displayNameKey: "sessionPlugins.mermaidRender.name",
  displayNameFallback: "Mermaid 图表渲染",
  descriptionKey: "sessionPlugins.mermaidRender.description",
  descriptionFallback: "流程图/时序图等 mermaid 代码块渲染为图形（可缩放放大、导出 PNG/SVG）",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:blocks"],
  mounts: [
    {
      kind: "block-renderer",
      languages: ["mermaid", "mmd"],
      detect: () => true,
      Component: MermaidDiagram,
    },
  ],
};
