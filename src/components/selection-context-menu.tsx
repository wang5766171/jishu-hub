/**
 * 选中文本右键菜单（v0.9.5 需求1（原需求26）5d）：消息区选中文本 →
 * 右键 → 自绘菜单「发送到插件 X」（导出/通知/插入输入框等动作）。
 *
 * 仅在有选区且位于消息流容器时拦截原生菜单（preventDefault），菜单保留
 * 「复制」项补偿原生能力损失；无选区/非消息区不干预（原生菜单照常）。
 * 动作执行：选中文字经 payload.text 传入（desktop-notify 用作内容、
 * insert-composer 插入输入框、clipboard 复制）。
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import i18n from "@/i18n";
import { invokeCommand } from "@/hooks/use-invoke";

interface PluginActionEntry {
  pluginId: string;
  pluginName: string;
  actionType: string;
  label: string;
}

interface MenuState {
  x: number;
  y: number;
  text: string;
}

/** 适配选中文本语义的动作类型（通知/剪贴板/插入输入框）。
 * 三轮评审开闭原则修复：新增动作类型想接入右键菜单时，在动作声明上加
 * `text_selection = true` 标记即可（清单自描述，宿主零改动）——白名单仅
 * 作为无标记历史清单的兼容回退，新动作禁止再加自名单。 */
const TEXT_SELECTION_FALLBACK_TYPES = new Set(["desktop-notify", "clipboard", "insert-composer"]);

/** 动作是否适配选中文本：显式声明优先，无声明回退白名单（历史兼容）。 */
function supportsTextSelection(action: Record<string, unknown>): boolean {
  if (action.text_selection === true) return true;
  if (action.text_selection === false) return false;
  return TEXT_SELECTION_FALLBACK_TYPES.has(String(action.type ?? ""));
}

/** 消息流容器选择器（chat 滚动区——选区限定在消息内才拦截）。 */
const MESSAGE_CONTAINER = "[data-message-stream]";

export function SelectionContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [entries, setEntries] = useState<PluginActionEntry[]>([]);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? "";
      const inStream = (e.target as HTMLElement | null)?.closest(MESSAGE_CONTAINER);
      if (!text || !inStream) {
        setMenu(null);
        return;
      }
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, text });
      // 启用插件的动作清单（组合式清单——经后端权威数据）。
      void (async () => {
        try {
          const items = (await invokeCommand<Array<{
            id: string;
            manifest: {
              plugin?: { name?: string };
              action?: Array<Record<string, unknown>>;
            };
          }>>("composed_plugin_manifests")) ?? [];
          const out: PluginActionEntry[] = [];
          for (const item of items) {
            for (const action of item.manifest.action ?? []) {
              const type = String(action.type ?? "");
              if (!supportsTextSelection(action)) {
                continue;
              }
              out.push({
                pluginId: item.id,
                pluginName: item.manifest.plugin?.name ?? item.id,
                actionType: type,
                label: String(action.label ?? type),
              });
            }
          }
          setEntries(out);
        } catch {
          setEntries([]);
        }
      })();
    };
    const onClickAway = (): void => setMenu(null);
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("click", onClickAway);
    window.addEventListener("scroll", onClickAway, true);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("click", onClickAway);
      window.removeEventListener("scroll", onClickAway, true);
    };
  }, []);

  const runAction = useCallback(
    async (entry: PluginActionEntry, text: string) => {
      setMenu(null);
      const { actionRegistry } = await import("@/features/session-kernel/capabilities/actions");
      const handler = actionRegistry.get(entry.actionType);
      if (!handler) return;
      await handler.run(
        { title: i18n.t("contextMenu.fromSelection", { plugin: entry.pluginName, defaultValue: "" }), body: text.slice(0, 200), text },
        { kind: "aggregate", data: [] } as never,
        { sessionId: null, pluginId: entry.pluginId },
      );
    },
    [],
  );

  if (!menu) return null;

  const style = {
    left: Math.min(menu.x, window.innerWidth - 220),
    top: Math.min(menu.y, window.innerHeight - 40 - entries.length * 30),
  };

  return createPortal(
    <div
      className="fixed z-[90] min-w-44 rounded-md border border-border bg-background py-1 shadow-lg"
      style={style}
    >
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(menu.text);
          setMenu(null);
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
      >
        {i18n.t("contextMenu.copyWithPreview", { text: menu.text.length > 12 ? menu.text.slice(0, 12) + "…" : menu.text, defaultValue: "" })}
      </button>
      {entries.map((entry) => (
        <button
          key={`${entry.pluginId}:${entry.actionType}`}
          type="button"
          onClick={() => void runAction(entry, menu.text)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
        >
          <span className="text-muted-foreground">{i18n.t("contextMenu.sendToPlugin", { defaultValue: "" })}</span>
          <span className="font-medium">{entry.pluginName}</span>
          <span className="text-muted-foreground/70">（{entry.label}）</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
