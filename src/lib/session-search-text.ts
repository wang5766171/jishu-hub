/**
 * 搜索用的「用户看得见的文字」——会话搜索的唯一文本出处（v0.9.8 需求23）。
 *
 * 此前侧栏搜索的计数与摘要直接用落盘原文 `block.text`，而气泡显示用的是剥掉
 * 内部注入块之后的文字：两边不是同一份，摘要里会露出内部标记，命中数也会把
 * 看不见的文字算进去。这里把「这条消息用户看到什么」收敛成一个函数：
 * - 用户消息：剥掉内部注入块（图片附件标记等），与气泡显示同一份；
 * - 助手消息：Markdown 源码 → 渲染后看得见的文字（只去掉语法符号，其余原样）。
 *
 * v0.9.8 评审修复轮 R2（用户裁决「标签的格式可以直接搜……搜索时识别原始文本即可」）：
 * 用户消息里跟在正文后面的工具标签按原始文本 `@[显示名]` 计入搜索文本，气泡里的
 * 标签在页面上也正是这段文字——搜索文本与页面文字逐字相等，侧栏徽标数、正文
 * 高亮数、标题栏计数才对得上。
 */
import type { Message } from "@/types";
import { toolTokenText, trailingToolIds } from "./tool-token";
import { extractEquipSegments } from "./equip-segments";

/** 剥掉用户消息里的内部注入块（图片附件提示等），得到气泡显示的文字。 */
export function stripImagePrompt(text: string): string {
  return text
    .replace(/<!--JISHU_HUB_IMAGES_BEGIN-->[\s\S]*?<!--JISHU_HUB_IMAGES_END-->/g, "")
    .replace(/\\n/g, "\n")
    .trim();
}

/**
 * 剥掉任务启动包装（内部路由指令 `/jishu-task dev|research`，不属于用户原话）。
 * 回放气泡的显示、复制与搜索文本共用这一处。
 */
export function stripTaskLaunchPrefix(text: string): string {
  return text.replace(/^\/jishu-task(?:\s+(?:dev|research))?\s+/, "");
}

/** 用户消息里用户看得见的正文：先剥任务启动包装，再剥图片附件标记。 */
export function userVisibleText(text: string): string {
  return stripImagePrompt(stripTaskLaunchPrefix(text));
}

const TABLE_SEPARATOR = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{0,}:?\s*\|?\s*$/;
const TABLE_ROW = /^\s*\|/;

/**
 * Markdown 源码 → 渲染后看得见的文字（近似投影），只用于搜索计数与摘要。
 *
 * 只去掉「渲染后不会显示」的语法，不改变其余文字的内容与先后顺序：行首的
 * 标题井号、引用符号、列表符号与任务勾选框，成对的粗体/斜体/删除线标记，
 * 行内代码的反引号，链接与图片只留方括号里的文字，分隔线，表格的分隔行与
 * 竖线。围栏代码块只去掉围栏行，**内部原样保留**（里面的 * _ | 都是正文）。
 * 不是完整的 Markdown 解析器：HTML 标签、脚注等少数写法不处理。
 */
export function markdownVisibleText(text: string): string {
  const lines = text.split("\n");
  const isTableRow = new Array<boolean>(lines.length).fill(false);
  const isSeparator = new Array<boolean>(lines.length).fill(false);
  // 先标出表格行：分隔行的上一行是表头，之后到空行为止是数据行；分隔行自身不显示。
  for (let i = 0; i < lines.length; i++) {
    if (TABLE_SEPARATOR.test(lines[i])) {
      isSeparator[i] = true;
      if (i > 0) isTableRow[i - 1] = true;
      for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) isTableRow[j] = true;
    }
  }

  const out: string[] = [];
  let inFence = false;
  let fenceChar = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
      } else if (fence[1][0] === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (isSeparator[i]) continue;
    if (isTableRow[i] || TABLE_ROW.test(line)) {
      // 以竖线开头的行按表格行处理（表格可能没有分隔行，如只有表头的写法）
      out.push(line.replace(/\s*\|\s*/g, " ").trim());
      continue;
    }
    out.push(projectProseLine(line));
  }
  return out.join("\n");
}

/** 普通段落行（不在围栏代码块、不是表格行）的语法剥离。 */
function projectProseLine(line: string): string {
  // 分隔线（--- / *** / ___）
  if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) return "";
  let s = line;
  s = s.replace(/^\s*(?:>\s*)+/, ""); // 引用
  s = s.replace(/^\s{0,3}#{1,6}\s+/, ""); // 标题（「#标签」这种无空格的不算）
  s = s.replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, ""); // 列表符号与任务勾选框
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // 图片：只留替代文字
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // 链接：只留链接文字
  s = s.replace(/`([^`]*)`/g, "$1"); // 行内代码
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1"); // 粗体
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1$2"); // 斜体：成对的星号，且不夹在单词里（a*b*c 不算）
  s = s.replace(/~~([^~]+)~~/g, "$1"); // 删除线
  return s;
}

type SearchableBlock = { type: string; text?: string; tool_ids?: string[] };
const NO_NAMES: Readonly<Record<string, string>> = {};
const cache = new WeakMap<object, {
  text: string;
  role: string;
  ids: string[] | undefined;
  names: Readonly<Record<string, string>>;
  visible: string;
}>();

/**
 * 用户文字块的搜索文本：看得见的正文 + 跟在正文后面的工具标签的原始文本
 * `@[显示名]`（显示名取不到时用 id——与标签上显示的文字一致）。标签之间、标签
 * 与正文之间都没有分隔：页面上的文字节点也是这样首尾相接的。
 */
function userSearchText(
  text: string,
  toolIds: string[] | undefined,
  toolNames: Readonly<Record<string, string>>,
): string {
  const body = userVisibleText(text);
  if (!toolIds || toolIds.length === 0) return body;
  return body + trailingToolIds(body, toolIds, toolNames).map((id) => toolTokenText(toolNames[id] ?? id)).join("");
}

/**
 * 助手文字块的搜索文本：只取看得见的文字段。装备推荐块（<JISHU-EQUIP-RECOMMEND>）
 * 在页面上渲染成推荐卡，块里的 JSON 不显示——不进搜索文本；分段用渲染的同一个函数
 *（二轮评审 R3 P2-11：此前整段按 Markdown 投影，理由里的词被数成命中、页面上却没有这段
 * 文字，标题栏与侧栏的计数比正文高亮多）。卡上的标题与理由是异步取回的另一份文字，卡
 * 自带 data-no-search，也不计入。
 */
function assistantSearchText(text: string): string {
  if (!text.includes("<JISHU-EQUIP-RECOMMEND>")) return markdownVisibleText(text);
  return extractEquipSegments(text)
    .filter((segment): segment is { type: "text"; content: string } => segment.type === "text")
    .map((segment) => markdownVisibleText(segment.content))
    .join("\n");
}

/**
 * 一个文字块的搜索文本。按块对象缓存——同一条消息在连续按键之间只算一次
 * （工具集或工具名映射换了会重算）。
 *
 * `toolNames`：id → 显示名。用户消息里带工具标签的块要靠它得出标签的原始文本；
 * 助手消息用不到。消息视图与侧栏搜索传的都是工具目录里的同一份映射。
 */
export function blockSearchText(
  block: SearchableBlock,
  role: Message["role"],
  toolNames: Readonly<Record<string, string>> = NO_NAMES,
): string {
  if (block.type !== "text" || typeof block.text !== "string") return "";
  const hit = cache.get(block);
  if (hit && hit.text === block.text && hit.role === role && hit.ids === block.tool_ids && hit.names === toolNames) {
    return hit.visible;
  }
  const visible = role === "user" ? userSearchText(block.text, block.tool_ids, toolNames) : assistantSearchText(block.text);
  cache.set(block, { text: block.text, role, ids: block.tool_ids, names: toolNames, visible });
  return visible;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 按关键词建全局正则（不区分大小写）。 */
export function searchRegExp(query: string): RegExp {
  return new RegExp(escapeRegExp(query), "gi");
}

/** 文本里的命中次数（不产生匹配数组）。 */
export function countMatches(text: string, regex: RegExp): number {
  let n = 0;
  for (const _ of text.matchAll(regex)) n++;
  return n;
}
