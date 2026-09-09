import { createContext, useContext, useMemo, type ReactNode } from "react";
import { listSessionPlugins } from "../registry";
import type { BlockRendererMount } from "../types";

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

/** 命中判定：语言在插件声明集合内且 detect 通过。返回首个命中（注册序优先）。 */
export function matchBlockRenderer(
  renderers: BlockRendererMount[],
  language: string,
  code: string,
): BlockRendererMount | null {
  const lang = language.toLowerCase();
  for (const renderer of renderers) {
    if (renderer.languages.length > 0 && !renderer.languages.includes(lang)) continue;
    if (renderer.detect(lang, code)) return renderer;
  }
  return null;
}

export function useBlockRenderers(): BlockRendererMount[] {
  return useContext(BlockRenderersContext);
}
