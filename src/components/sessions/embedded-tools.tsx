/**
 * v0.9.0 需求3 方案 C：消息内嵌工具 pill 渲染——数据源为消息元数据
 * `tool_ids`（回放：后端从注入块派生；流式：compose 时前端已知并显式传递）。
 * 文本标记（[JISHU-TOOLS:...]）方案已按版本级裁决整体废弃；本模块对文本做的
 * 解析只有一种——用户填入的 `@[显示名]` 字样（v0.9.8 需求9：用户放在哪，标签
 * 就在哪），写法与判定在 `lib/tool-token.ts`，本模块不自带正则。
 *
 * v0.9.8 评审修复轮 R2：pill 里的文字是标签的原始文本 `@[显示名]`（见 PillLabel），
 * 搜索按它识别标签；工具名与类别的映射取自全局工具目录（lib/tool-catalog.ts）。
 */

import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Blocks, Package, Server, Sparkles, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ensureToolCatalog, getToolCats, getToolNames, subscribeToolCatalog } from "@/lib/tool-catalog";
import { findToolTokens, toolTokenText, trailingToolIds } from "@/lib/tool-token";

/**
 * 工具名映射（id → 显示名）。pill 显示中文名，标记与后端通信仍用英文 id。
 * 映射是全局工具目录里的那一份（与具体会话无关）：已经取到过就是现成的，新会话
 * 第一帧就有显示名；还没有时在这里发起加载。`sessionId` 只随请求带给后端。
 */
export function useSessionToolNames(sessionId: string | null): Record<string, string> {
  useEffect(() => {
    ensureToolCatalog(sessionId);
  }, [sessionId]);
  return useSyncExternalStore(subscribeToolCatalog, getToolNames, getToolNames);
}

/** 工具名映射（不针对某个会话）：侧栏搜索用它认出消息里的工具标签，并触发目录加载。 */
export function useToolNames(): Record<string, string> {
  return useSessionToolNames(null);
}

/** id → category 映射（pill 图标按类型），与显示名取自同一份工具目录。 */
export function useSessionToolCats(sessionId: string | null): Record<string, string> {
  useEffect(() => {
    ensureToolCatalog(sessionId);
  }, [sessionId]);
  return useSyncExternalStore(subscribeToolCatalog, getToolCats, getToolCats);
}

/**
 * 标签里的文字 = 标签的原始文本 `@[显示名]`：显示名看得见；首尾的 `@[` `]` 是原始
 * 文本的一部分，留在页面文字里（搜索按原始文本识别标签——搜显示名、搜 `@[名]`
 * 都命中这一个标签），不占宽度。外层是一个不设间距的弹性盒：零宽的首尾两段不参与
 * 图标与名字之间的间距。
 */
function PillLabel({ name }: { name: string }) {
  return (
    <span className="flex min-w-0 items-center">
      <span className="w-0 shrink-0 overflow-hidden" aria-hidden="true">{"@["}</span>
      <span className="truncate">{name}</span>
      <span className="w-0 shrink-0 overflow-hidden" aria-hidden="true">{"]"}</span>
    </span>
  );
}

/** 消息气泡内的内联工具 pill 组（v0.8.1 28f37e8e 形态修正：**内联**渲染——
 * 与正文同一个 whitespace-pre-wrap 流，pill 与文本同行排列，不再用块级
 * div 强制换行。pill 是一个视觉整体，仅渲染，不做其他特殊处理。
 * 每个 pill 在页面上的文字是它的原始文本 `@[显示名]`，见 PillLabel）。 */
export function EmbeddedToolPills({
  toolIds,
  toolNames,
  toolCats,
  onRemove,
  trailing,
}: {
  toolIds: string[];
  toolNames: Record<string, string>;
  /** 需求7 补充：id→category（pill 图标按类型；不传=默认 Blocks 形态）。 */
  toolCats?: Record<string, string>;
  /** 收版反馈（2026-11-13 用户裁决）：编辑态工具可删——传入后每个 pill 带
   * 移除按钮（删除本次重发不再携带该工具调用；不传=静态展示）。 */
  onRemove?: (id: string) => void;
  /** v0.9.8 需求9-②：pill 位于正文之后时置 true——外距换向前（mr→ml），
   * 与前置排版的间距镜像。 */
  trailing?: boolean;
}) {
  // 评审 P1-11 修复：移除钮 title 直出中文改 t()（hook 须在提前 return 之前）。
  const { t } = useTranslation();
  if (toolIds.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1 align-baseline", trailing ? "ml-1" : "mr-1")}>
      {toolIds.map((id) => (
        <span
          key={id}
          className="inline-flex max-w-[10rem] items-center gap-1 rounded-md border border-border/70 bg-muted/70 px-1.5 py-0.5 align-baseline text-xs text-foreground"
          title={id}
        >
          {pillIcon(toolCats?.[id])}
          <PillLabel name={toolNames[id] ?? id} />
          {onRemove && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(id); }}
              className="-mr-0.5 ml-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-destructive/15 hover:text-destructive"
              title={t("sessions.toolPillRemove", "删除此工具调用（重发不再携带）")}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          )}
        </span>
      ))}
    </span>
  );
}

/** 名字→category（正文内联 pill 只有 @[名]：names 反查 id → cats）。 */
function kindForName(
  names: Record<string, string> | undefined,
  cats: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!names || !cats) return undefined;
  const id = Object.keys(names).find((k) => names[k] === name);
  return id ? cats[id] : undefined;
}

/** pill 图标映射（需求7 补充：与 + 菜单同款——skill=Sparkles/
 * mcp=Server/extension=Package/cli=Blocks，颜色同步）。 */
function pillIcon(kind?: string) {
  switch (kind) {
    case "skill":
      return <Sparkles className="h-3 w-3 shrink-0 text-[var(--icon-theme)]" />;
    case "mcp":
      return <Server className="h-3 w-3 shrink-0 text-[var(--icon-action)]" />;
    case "extension":
      return <Package className="h-3 w-3 shrink-0 text-[var(--icon-config)]" />;
    case "agent-tool":
      return <Wrench className="h-3 w-3 shrink-0 text-[var(--icon-action)]" />;
    default:
      return <Blocks className="h-3 w-3 shrink-0 text-[var(--icon-config)]" />;
  }
}

/** 单个工具 pill：输入框 mirror 层与消息正文内联共用。
 * 结构：透明等宽占位（与 textarea 里 token 文本等宽）+ 绝对定位的可见
 * pill——保证光标位置与视觉 pill 对齐。 */
export function EmbeddedToolPill({ name, kind }: { name: string; kind?: string }) {
  return (
    <span className="relative inline-flex" data-tool-pill="">
      {/* 等宽占位：与 textarea 中的 `@[name]` 文本等宽（同字体继承）。只是排版用的
          一份拷贝，不参与搜索——页面上的原始文本由下面看得见的那份给出。 */}
      <span className="invisible whitespace-pre" data-no-search="">@[{name}]</span>
      <span className="absolute inset-y-0 left-0 inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted px-1.5 text-xs leading-none text-foreground">
        {pillIcon(kind)}
        <PillLabel name={name} />
      </span>
    </span>
  );
}

/** v0.9.8 需求9 路线甲：正文是否含**可内联**的 @[名] 字样（名字在
 * toolNames 映射中）——含则渲染走 UserTextWithPills 内联（用户填入位置），
 * 不含（历史剥离消息）走原 TextBlock+尾随 pill 路径。 */
export function hasKnownToolToken(
  text: string,
  toolNames: Record<string, string> | undefined,
): boolean {
  if (!text || !toolNames) return false;
  const knownNames = new Set(Object.values(toolNames));
  return findToolTokens(text).some((token) => knownNames.has(token.name));
}

/** v0.9.8 需求9 路线甲：编辑提交时从 draft 文本反扫工具 id（@[名] 字样
 * 即载体——编辑态 pill 列表在文本含字样时不置，提交以文本为准）。
 * 两个工具显示名相同时取清单里靠前的那个——与后端 resolve_tool_refs、
 * chat-input 的 extractToolTokens 同一规则（工程指导 §16.3）。 */
export function scanToolIdsFromText(
  text: string,
  toolNames: Record<string, string>,
): string[] {
  const ids: string[] = [];
  const nameToId = new Map<string, string>();
  for (const [id, name] of Object.entries(toolNames)) {
    if (!nameToId.has(name)) nameToId.set(name, id);
  }
  for (const { name } of findToolTokens(text)) {
    const id = nameToId.get(name);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * 用户消息正文展示统一组件（M5 → v0.9.0 需求3 元数据化；展示面单源纪律 §16.3）：
 * 正文里的 `@[名]` 字样在原位渲染成标签，没被字样覆盖到的工具（历史剥离消息的
 * 全部工具）跟在正文**之后**（v0.9.8 需求9-②：注入本就是后缀追加——
 * compose_tool_message 单源，原「pill 恒前置」误导用户以为工具挂在消息开头）。
 * 标签与正文在同一个内联流里。
 */
export function UserTextWithPills({
  text,
  toolIds,
  toolNames,
  toolCats,
}: {
  text: string;
  toolIds: string[];
  toolNames: Record<string, string>;
  /** 需求7 补充：id→category（pill 图标按类型）。 */
  toolCats?: Record<string, string>;
}) {
  // v0.9.8 需求5（合并版）：`@[名]` 原文内联 pill 化（名字在 toolNames
  // 映射中存在才转换——未知 @[x] 按原文）。
  // v0.9.8 需求9 路线甲（用户裁决「用户放在哪就是哪」）：全部类型 token
  // 原文保留（发送链 extractToolTokens 恒保留），内联渲染即用户填入位置；
  // 名字对不上的 `@[x]` 按原文显示。
  let textNode: import("react").ReactNode = text;
  const knownNames = new Set(Object.values(toolNames));
  const parts: import("react").ReactNode[] = [];
  let last = 0;
  for (const { index, name } of findToolTokens(text)) {
    if (!knownNames.has(name)) continue;
    if (index > last) parts.push(text.slice(last, index));
    parts.push(<EmbeddedToolPill key={`pill-${index}`} name={name} kind={kindForName(toolNames, toolCats, name)} />);
    last = index + toolTokenText(name).length;
  }
  if (last > 0) {
    if (last < text.length) parts.push(text.slice(last));
    textNode = parts;
  }
  // 跟在正文后面的标签：工具集里没有被上面的内联覆盖到的 id（内联与尾随不重复
  // 出同一个工具）。与搜索文本用同一个判定（lib/tool-token）。
  return (
    <span className="whitespace-pre-wrap break-all">
      {textNode}
      <EmbeddedToolPills toolIds={trailingToolIds(text, toolIds, toolNames)} toolNames={toolNames} toolCats={toolCats} trailing />
    </span>
  );
}
