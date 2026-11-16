/**
 * 工具返回值内容嗅探（v0.9.5 需求1（原需求26）8a）：按内容特征自动选
 * 渲染器——零配置层（层一），插件认领（tool-result 源）优先后兜底。
 *
 * 特征判定（01 §八层一设计）：
 * - `<svg` 开头 → SVG 图
 * - `<html` / `<!DOCTYPE` 开头 → HTML（sandbox iframe srcdoc，禁脚本）
 * - JSON 含 columns + rows → 表格
 * - data:image/ 或 base64 图片前缀 → 图片
 * - Markdown 语法密度 → 富文本（保守阈值：标题/列表/代码块至少两项）
 * - 其余 → 默认工具卡文本
 */
export type SniffedType = "svg" | "html" | "table-json" | "image-data" | "markdown" | "text";

export function sniffContentType(content: string): SniffedType {
  const trimmed = content.trim();
  if (!trimmed) return "text";
  const lower = trimmed.slice(0, 200).toLowerCase();
  if (lower.startsWith("<svg")) return "svg";
  if (lower.startsWith("<html") || lower.startsWith("<!doctype html")) return "html";
  // JSON 表格：{columns: [...], rows: [[...]]}
  if ((trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const obj = Array.isArray(parsed) ? parsed[0] : parsed;
      if (
        obj &&
        typeof obj === "object" &&
        Array.isArray((obj as { columns?: unknown }).columns) &&
        Array.isArray((obj as { rows?: unknown }).rows)
      ) {
        return "table-json";
      }
    } catch {
      // 非 JSON 落后续判定
    }
  }
  if (lower.startsWith("data:image/")) return "image-data";
  // base64 裸串（长且 base64 字符集，常见 PNG 头 iVBOR）。
  if (trimmed.length > 64 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed) && /iVBOR|\/9j\//.test(trimmed.slice(0, 64))) {
    return "image-data";
  }
  // Markdown 密度：标题/列表/代码块/表格线至少两项。
  let mdHits = 0;
  if (/^#{1,6}\s+\S/m.test(trimmed)) mdHits++;
  if (/^\s*[-*+]\s+\S/m.test(trimmed) || /^\s*\d+\.\s+\S/m.test(trimmed)) mdHits++;
  if (/```/.test(trimmed)) mdHits++;
  if (/^\|.*\|$/m.test(trimmed)) mdHits++;
  if (mdHits >= 2) return "markdown";
  return "text";
}
