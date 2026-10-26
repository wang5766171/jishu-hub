import { createContext, useContext, useMemo, type ReactNode } from "react";
import { listSessionPlugins } from "../registry";
import type { BlockRendererMount, BlockTypeRendererMount, CodeBlockRendererMount } from "../types";

/**
 * 块渲染器宿主（v0.9.2 需求1 M4）：核心 markdown 渲染（message-view TextBlock）
 * 经 Context 咨询「已启用插件的块渲染器」；命中则渲染插件组件，未命中/全部
 * 禁用时回退核心渲染。插件不侵入渲染管线——内核提供咨询点。
 */
const BlockRenderersContext = createContext<BlockRendererMount[]>([]);

export function BlockRenderersProvider({
  enabled,
  children,
}: {
  enabled: Set<string>;
  children: ReactNode;
}) {
  const renderers = useMemo(
    () =>
      listSessionPlugins()
        .filter((plugin) => enabled.has(plugin.id))
        .flatMap((plugin) =>
          plugin.mounts.filter(
            (mount): mount is BlockRendererMount => mount.kind === "block-renderer",
          ),
        ),
    [enabled],
  );
  return <BlockRenderersContext.Provider value={renderers}>{children}</BlockRenderersContext.Provider>;
}

/** 命中判定：仅代码块域挂载参与——语言在插件**显式声明**的封闭集内且
 * detect 通过；空语言集不匹配任何东西（**无通配**——测试期修复23 结构
 * 收口：v0.9.2 的"空数组=全部语言"通配使挂载可捕获 bash 等常规对话代码块，
 * 与用户裁决的「内部格式不与常规对话内容重叠」相悖，废除）。块类型域挂载
 * 在类型层即被排除。返回首个命中（注册序优先）。 */
export function matchBlockRenderer(
  renderers: BlockRendererMount[],
  language: string,
  code: string,
): CodeBlockRendererMount | null {
  const lang = language.toLowerCase();
  for (const renderer of renderers) {
    if (renderer.matching !== "code") continue;
    if (renderer.languages.length === 0 || !renderer.languages.includes(lang)) continue;
    if (renderer.detect(lang, code)) return renderer;
  }
  return null;
}

/** 行级咨询点（v0.9.3 需求2 / P1-2）：仅块类型域挂载参与——按核心块类型
 *  （interaction/phase_divider 等非代码块）匹配接管渲染，返回首个命中
 *  （注册序优先）；未命中由核心回退内置渲染。联合臂必带 BlockComponent。 */
export function matchBlockTypeRenderer(
  renderers: BlockRendererMount[],
  blockType: string,
): BlockTypeRendererMount | null {
  for (const renderer of renderers) {
    if (renderer.matching === "block-type" && renderer.blockTypes.includes(blockType)) return renderer;
  }
  return null;
}

export function useBlockRenderers(): BlockRendererMount[] {
  return useContext(BlockRenderersContext);
}
