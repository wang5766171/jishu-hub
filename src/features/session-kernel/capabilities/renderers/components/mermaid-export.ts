/**
 * mermaid 导出/规范化管线（v0.9.3 需求13 C1：自 builtin/mermaid-render.tsx
 * 剥离——渲染组件的能力实现，export-file 动作经 toFile 路由到此）。
 * 函数体逐字搬迁，既有单测锁定行为。
 */
import type { PluginConfigValues } from "../../../plugins/config-plane";
import type { SourcePayload } from "../../types";

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

/** 渲染失败提示提取（v0.9.3 测试期：语法错误就地显示在图卡位置）。
 * mermaid 抛的 Parse error 常带多行上下文与堆栈串，取首行并截断。 */
export function mermaidErrorBrief(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? raw;
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
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




/** 组件能力入口（render.mermaid.capabilities.toFile）：payload → png/svg 产物。 */
export async function mermaidToFile(
  payload: SourcePayload,
  format: string,
  options: PluginConfigValues = {},
): Promise<Blob | string> {
  if (payload.kind !== "code-block") throw new Error("mermaid toFile 仅接受 code-block payload");
  const mermaid = await loadMermaidForExport();
  const { svg: raw } = await mermaid.render(
    `mmd-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    payload.code,
  );
  if (format === "svg") {
    return wellFormSvgXml(foreignObjectsToText(buildExportSvg(raw).svg));
  }
  if (format === "png") {
    const scale = typeof options.pngScale === "number" ? options.pngScale : 2;
    return await svgToPngBlob(buildExportSvg(raw).svg, scale);
  }
  throw new Error(`mermaid 不支持导出 ${format}`);
}

let exportMermaidReady: Promise<typeof import("mermaid").default> | null = null;

async function loadMermaidForExport() {
  if (!exportMermaidReady) {
    exportMermaidReady = import("mermaid").then((mod) => {
      mod.default.initialize({ startOnLoad: false, securityLevel: "strict" });
      return mod.default;
    });
  }
  return exportMermaidReady;
}
