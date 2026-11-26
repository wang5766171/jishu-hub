// 助手文本里的装备推荐块 → 段分割（纯函数，无依赖）。
//
// 智能体在回复里输出 <JISHU-EQUIP-RECOMMEND>{json}</JISHU-EQUIP-RECOMMEND> 块（组套协议，
// 目录注入见 equip-catalog.md）。放在最底层是因为三处都要用同一个分段：消息视图按它把
// 块渲染成推荐卡；搜索文本按它只取看得见的文字段（二轮评审 R3 P2-11：块里的 JSON 不显示，
// 不能进搜索文本——此前「标题栏 2 处、页面只黄 1 处」）；推荐卡自己带 data-no-search
//（卡上的标题与理由是异步取回的另一份文字，不属于这条消息的正文）。

const OPEN = "<JISHU-EQUIP-RECOMMEND>";
const CLOSE = "</JISHU-EQUIP-RECOMMEND>";

export interface EquipRecommendItem {
  ref: string;
  reason: string;
}

export interface EquipRecommendPayload {
  items: EquipRecommendItem[];
  profile?: { scene?: string; keywords?: string[] };
}

export type EquipSegment =
  | { type: "text"; content: string }
  | { type: "recommend"; payload: EquipRecommendPayload };

/**
 * 文本 → 段分割（推荐块 + 普通文本）。容错：块内 JSON 非法/缺 items 时
 * 当普通文本（流式半写同理——无闭合标记不切分，闭合后下一渲染帧接管）。
 */
export function extractEquipSegments(text: string): EquipSegment[] {
  if (!text.includes(OPEN)) return [{ type: "text", content: text }];
  const segments: EquipSegment[] = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf(OPEN);
    if (start < 0) break;
    const end = rest.indexOf(CLOSE, start + OPEN.length);
    if (end < 0) break; // 半写：整段按文本处理（下次渲染重试）
    const before = rest.slice(0, start);
    if (before.trim()) segments.push({ type: "text", content: before.trimEnd() });
    const body = rest.slice(start + OPEN.length, end).trim();
    try {
      const payload = JSON.parse(body) as EquipRecommendPayload;
      if (Array.isArray(payload.items) && payload.items.length > 0) {
        segments.push({ type: "recommend", payload });
      }
    } catch {
      // JSON 非法：静默丢弃块（设计 §十二：失败静默不渲染，不报错打扰）。
    }
    rest = rest.slice(end + CLOSE.length).replace(/^\r?\n[\r\n]*/, "");
  }
  if (rest.trim()) segments.push({ type: "text", content: rest.trimEnd() });
  return segments;
}
