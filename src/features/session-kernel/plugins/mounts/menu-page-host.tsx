/**
 * MenuPageHost —— 菜单页宿主（二十二轮）：整页渲染菜单挂载插件的
 * Component。挂在 chat-page 消息区（SessionPanelLayer 同级、z 序更高），
 * 打开时覆盖会话内容区——「单独的页面，不是会话页面」（用户裁决）。
 *
 * 与面板宿主（SessionPanelLayer）平行的通用容器：零菜单插件专属逻辑
 * （开闭原则）——只认 MenuPageRequest 通道 + 描述符 menu 挂载。
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { consumeMenuPage, useMenuPageRequest } from "../../shell/menu-page";
import { listSessionPlugins, useEnabledSessionPlugins } from "../registry";
import type { SessionKernelContext } from "../types";

export function MenuPageHost({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const req = useMenuPageRequest();
  const enabled = useEnabledSessionPlugins();
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!req) return;
    setOpenId(req.pluginId === "__close__" ? null : req.pluginId);
    consumeMenuPage();
  }, [req]);

  // 打开中的插件被禁用/卸载 → 页面随之关闭（不留白屏壳）。
  useEffect(() => {
    if (openId && !enabled.has(openId)) setOpenId(null);
  }, [enabled, openId]);

  if (!openId) return null;
  const mount = listSessionPlugins()
    .find((p) => p.id === openId)
    ?.mounts.find((m) => m.kind === "menu");
  if (!mount || mount.kind !== "menu") return null;
  const Component = mount.Component;
  const title = t(mount.titleKey, mount.titleFallback);

  return (
    <div
      data-menu-page={openId}
      className="absolute inset-0 z-30 flex min-h-0 flex-col rounded-lg border border-border/60 bg-background shadow-lg"
    >
      {/* 页头：标题 + 关闭（与停靠面板头同风格；无停靠/拖拽语义——页面是
          整页容器，位置固定）。 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <span className="truncate text-[13px] font-medium text-foreground">{title}</span>
        <button
          type="button"
          aria-label={t("menuPage.close", "关闭")}
          title={t("menuPage.close", "关闭")}
          onClick={() => setOpenId(null)}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
          )}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* 页面体：插件 Component 整区域渲染（overflow 由页面内容自理）。 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Component ctx={ctx} />
      </div>
    </div>
  );
}
