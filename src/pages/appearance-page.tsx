/**
 * 需求14 M2（S3 外观能力点）：外观设置页——主题卡列表（内置三档 + 启用中
 * 的主题插件），互斥激活（state.theme 单真源，B5；点击即全 App 生效）。
 * 标题栏循环按钮保留为快捷切换（内置档间轮换）；未选任何主题插件 = 内置基座。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTheme, isBuiltinTheme, type BuiltinTheme } from "@/hooks/use-theme";
import { invokeCommand } from "@/hooks/use-invoke";
import { useTranslation } from "react-i18next";
import { listSessionPlugins } from "@/features/session-kernel/plugins/registry";
import {
  composedVersion,
  subscribeComposed,
} from "@/features/session-kernel/capabilities/composition/loader";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Check, Palette } from "lucide-react";

const BUILTIN_META: Array<{ key: BuiltinTheme; labelKey: string; fallback: string; swatch: string[] }> = [
  { key: "light", labelKey: "appearance.light", fallback: "浅色", swatch: ["#ffffff", "#f4f4f5", "#3f3f46"] },
  { key: "colorful", labelKey: "appearance.colorful", fallback: "彩色", swatch: ["#fdf4ff", "#f0abfc", "#7c3aed"] },
  { key: "dark", labelKey: "appearance.dark", fallback: "暗色", swatch: ["#0b1220", "#1e293b", "#e2e8f0"] },
];

function Swatch({ colors }: { colors: string[] }) {
  return (
    <div className="flex h-9 w-full overflow-hidden rounded-md border border-border/50">
      {colors.map((c, i) => (
        <span key={i} className="flex-1" style={{ backgroundColor: c }} />
      ))}
    </div>
  );
}

export function AppearancePage() {
  const { t } = useTranslation();
  const tr = (k: string, f: string) => (t(k) === k ? f : t(k));
  const { theme, setTheme } = useTheme();
  useSyncExternalStore(subscribeComposed, composedVersion, () => 0);
  // 启用集（主题插件须先在插件中心启用才可选——含代码的确认链在彼处闭环）。
  const [enabledIds, setEnabledIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const list = await invokeCommand<{ plugins: Array<{ id: string; enabled: boolean }> }>(
          "plugin_list",
        );
        if (alive) {
          setEnabledIds(new Set((list.plugins ?? []).filter((p) => p.enabled).map((p) => p.id)));
        }
      } catch {
        if (alive) setEnabledIds(null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const themePlugins = listSessionPlugins().filter(
    (p) => p.theme && (!enabledIds || enabledIds.has(p.id)),
  );

  return (
    <div className="space-y-5 p-1">
      <div>
        <h3 className="text-base font-semibold">{tr("appearance.title", "外观")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {tr("appearance.desc", "主题与聊天背景——内置三档 + 已启用的主题插件（可让 agent 按「插件创作指南」的模板自建）。")}
        </p>
      </div>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
        {BUILTIN_META.map((meta) => {
          const active = theme === meta.key;
          return (
            <button
              key={meta.key}
              type="button"
              onClick={() => setTheme(meta.key)}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors",
                active ? "border-primary" : "border-border/60 hover:border-border",
              )}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">{tr(meta.labelKey, meta.fallback)}</span>
                {active ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
              </div>
              <Swatch colors={meta.swatch} />
              <Badge variant="outline" className="mt-2 px-1 py-0 text-[9px] text-muted-foreground">
                {tr("appearance.builtin", "内置")}
              </Badge>
            </button>
          );
        })}
        {themePlugins.map((p) => {
          const active = theme === p.id;
          const swatch = p.theme?.preview?.length ? p.theme.preview : ["#0b1220", "#1e293b", "#e2e8f0"];
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setTheme(p.id)}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors",
                active ? "border-primary" : "border-border/60 hover:border-border",
              )}
            >
              <div className="mb-2 flex items-center justify-between gap-1">
                <span className="truncate text-sm font-medium">{p.displayNameFallback}</span>
                {active ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
              </div>
              <Swatch colors={swatch} />
              <Badge variant="outline" className="mt-2 px-1 py-0 text-[9px] text-muted-foreground">
                <Palette className="mr-1 h-2.5 w-2.5" />
                {tr("appearance.pluginTheme", "主题插件")}
              </Badge>
            </button>
          );
        })}
      </div>
      {themePlugins.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">
          {tr("appearance.noPlugins", "暂无已启用的主题插件——在会话里对 agent 说「给我一个深绿主题」即可按模板产出安装。")}
        </p>
      ) : null}
      {!isBuiltinTheme(theme) && !themePlugins.some((p) => p.id === theme) ? (
        <p className="text-xs text-amber-600">
          {tr("appearance.staleTheme", "当前选中的主题插件已停用或移除——已自动回落内置暗色。")}
        </p>
      ) : null}
    </div>
  );
}
