/**
 * Mermaid 渲染组件（v0.9.3 需求13 C1：自 builtin/mermaid-render.tsx 剥离）。
 * 第三方绑定=mermaid npm 库——组合式插件的唯一代码位。行为与剥离前逐字
 * 等价：parse 前置 + 离屏宿主 + firstChild 竞态守卫 + 模块层 render 收口。
 * 配置经 options 注入（需求12 配置面直通），导出动作条经 actions 注入。
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Minus, Plus, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import { cfgBool, cfgNum } from "../../../plugins/config-plane";
import type { RendererComponentProps, SourcePayload } from "../../types";
import { rendererRegistry } from "../registry";
import {
  buildExportSvg,
  foreignObjectsToText,
  mermaidErrorBrief,
  mermaidToFile,
  parseSvgSize,
  wellFormSvgXml,
} from "./mermaid-export";

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
async function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      const hidden = document.createElement("div");
      hidden.setAttribute("aria-hidden", "true");
      hidden.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;";
      document.body.appendChild(hidden);
      const origRender = mermaid.render.bind(mermaid);
      const patchedRender = async (id: string, text: string, container?: Element) => {
        const host = container ?? hidden;
        try {
          return await origRender(id, text, host);
        } finally {
          if (!container) hidden.innerHTML = "";
        }
      };
      (mermaid as unknown as { render: typeof patchedRender }).render = patchedRender;
      return mermaid;
    });
  }
  return mermaidReady;
}

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

function SvgHost({ svg }: { svg: string }) {
  return (
    <div
      className="mermaid-svg-host [&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function MermaidZoomOverlay({
  svg,
  options,
  onClose,
  onExport,
}: {
  svg: string;
  options: RendererComponentProps["options"];
  onClose: () => void;
  onExport: (format: "png" | "svg") => void;
}) {
  const { t } = useTranslation();
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const areaRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ id: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
    setScale(Math.min(Math.max(target, cfgNum(options, "minScalePct", 15) / 100), cfgNum(options, "maxScaleX", 6)));
    setPan({ x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, svg]);

  useEffect(() => {
    fitContain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svg]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale((prev) => {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        return Math.min(Math.max(prev * factor, cfgNum(options, "minScalePct", 15) / 100), cfgNum(options, "maxScaleX", 6));
      });
    };
    area.addEventListener("wheel", onWheel, { passive: false });
    return () => area.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const endDrag = useCallback(() => {
    dragState.current = null;
    setDragging(false);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
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

  const zoomBtn = (dir: "in" | "out") => () =>
    setScale((s) =>
      Math.min(
        cfgNum(options, "maxScaleX", 6),
        Math.max(cfgNum(options, "minScalePct", 15) / 100, dir === "in" ? s * 1.25 : s / 1.25),
      ),
    );

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" />
      <div className="absolute inset-4 flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl sm:inset-6">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          <span className="text-xs font-medium text-foreground">{t("sessionPlugins.mermaidRender.zoomTitle", "图表放大")}</span>
          <div className="ml-3 flex items-center gap-0.5">
            <button type="button" title={t("sessionPlugins.mermaidRender.zoomOut", "缩小")} onClick={zoomBtn("out")}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="w-11 select-none text-center text-[11px] tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</span>
            <button type="button" title={t("sessionPlugins.mermaidRender.zoomIn", "放大")} onClick={zoomBtn("in")}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button type="button" title={t("sessionPlugins.mermaidRender.fitWidth", "适配屏幕")} onClick={fitContain}
              className="ml-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground">
              {t("sessionPlugins.mermaidRender.fitWidth", "适配")}
            </button>
          </div>
          <div className="ml-3 flex items-center gap-0.5">
            <button type="button" title={t("sessionPlugins.mermaidRender.exportPng", "导出 PNG")} onClick={() => onExport("png")}
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground">PNG</button>
            <button type="button" title={t("sessionPlugins.mermaidRender.exportSvg", "导出 SVG")} onClick={() => onExport("svg")}
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground">SVG</button>
          </div>
          <span className="ml-auto select-none rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground/70">
            {t("sessionPlugins.mermaidRender.escHint", "ESC 关闭")}
          </span>
          <button type="button" title={t("sessionPlugins.mermaidRender.close", "关闭")} onClick={onClose}
            className="ml-1.5 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div
          ref={areaRef}
          className={cn("flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden bg-muted/10", dragging ? "cursor-grabbing" : "cursor-grab")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={fitContain}
        >
          <div ref={stageRef} className="select-none p-4" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}>
            <SvgHost svg={svg} />
          </div>
        </div>
      </div>
    </div>
  );
}

function MermaidDiagram({ payload, options, actions }: RendererComponentProps<SourcePayload>) {
  const { t } = useTranslation();
  const code = payload.kind === "code-block" ? payload.code : "";
  const [svg, setSvg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mode, setMode] = useState<"diagram" | "source">("diagram");
  const [expanded, setExpanded] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const dark = useIsDarkTheme();
  const idRef = useRef(`mmd-${useId().replace(/[^a-zA-Z0-9]/g, "")}`);
  const renderHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setErrorMsg(null);
    setSvg(null);
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark && cfgBool(options, "themeFollow", true) ? "dark" : "default",
        });
        await mermaid.parse(code);
        const { svg: raw } = await mermaid.render(idRef.current, code, renderHostRef.current ?? undefined);
        if (cancelled) return;
        setSvg(buildExportSvg(raw).svg);
      } catch (e) {
        if (!cancelled) setErrorMsg(mermaidErrorBrief(e));
      } finally {
        if (!cancelled) {
          if (renderHostRef.current) renderHostRef.current.innerHTML = "";
          document.getElementById(`d${idRef.current}`)?.remove();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, dark]);

  const exportFormat = useCallback(
    async (format: "png" | "svg") => {
      if (!payload || exportError) return;
      try {
        const out = await mermaidToFile(payload, format, options);
        const ext = format === "png" ? "png" : "svg";
        const path = await save({ defaultPath: `mermaid.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
        if (!path) return;
        if (typeof out === "string") {
          await invoke("export_text_file", { path, content: out });
        } else {
          const buf = await out.arrayBuffer();
          let binary = "";
          const bytes = new Uint8Array(buf);
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
          }
          await invoke("export_binary_file", { path, base64Data: btoa(binary) });
        }
        setExportError(null);
      } catch (e) {
        setExportError(String(e));
      }
    },
    [payload, options, exportError],
  );

  if (errorMsg !== null) {
    return (
      <div className="my-2 overflow-hidden rounded-lg border border-red-500/40">
        <div ref={renderHostRef} aria-hidden className="pointer-events-none absolute -left-[9999px] top-0 invisible" />
        <div className="flex items-start gap-1.5 border-b border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-600 dark:text-red-300">
          <div className="min-w-0">
            <div className="font-medium">{t("sessionPlugins.mermaidRender.syntaxError", "Mermaid 语法错误")}</div>
            <div className="break-all opacity-80">{errorMsg}</div>
          </div>
        </div>
        <pre className="max-h-64 overflow-auto bg-muted/20 p-2 text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/60 bg-muted/20">
      <div ref={renderHostRef} aria-hidden className="pointer-events-none absolute -left-[9999px] top-0 invisible" />
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border/40 px-1.5 py-1">
        <div className="ml-auto flex items-center gap-0.5">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              onClick={() => void action.run()}
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {action.label}
            </button>
          ))}
          <button
            type="button"
            title={mode === "diagram" ? t("sessionPlugins.mermaidRender.viewSource", "源码") : t("sessionPlugins.mermaidRender.viewDiagram", "图表")}
            onClick={() => setMode((m) => (m === "diagram" ? "source" : "diagram"))}
            className={cn("rounded p-1 outline-none hover:bg-accent", mode === "diagram" ? "text-foreground" : "text-muted-foreground")}
          >
            <span className="text-[10px]">{mode === "diagram" ? "⌗" : "◱"}</span>
          </button>
        </div>
      </div>
      {mode === "source" ? (
        <pre className="max-h-96 overflow-auto p-2 text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
      ) : (
        <div className="flex justify-center p-2">
          {svg ? (
            <div
              className="max-w-full cursor-zoom-in"
              style={{ width: Math.round(parseSvgSize(svg).width * (cfgNum(options, "inlineScalePct", 50) / 100)) }}
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
      )}
      {exportError ? (
        <div className="border-t border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-600 dark:text-red-300">
          {t("sessionPlugins.mermaidRender.exportFailed", "导出失败")}：{exportError}
        </div>
      ) : null}
      {expanded && svg
        ? createPortal(
            <MermaidZoomOverlay svg={svg} options={options} onClose={() => setExpanded(false)} onExport={(f) => void exportFormat(f)} />,
            document.body,
          )
        : null}
    </div>
  );
}

rendererRegistry.register({
  key: "render.mermaid",
  component: MermaidDiagram,
  description: "mermaid 代码块渲染为可缩放/可导出图表（第三方 mermaid 库）",
  capabilities: {
    exportFormats: ["png", "svg"],
    toFile: (payload, format, options) => mermaidToFile(payload, format, options),
  },
});

export { buildExportSvg, foreignObjectsToText, mermaidErrorBrief, parseSvgSize, wellFormSvgXml };
