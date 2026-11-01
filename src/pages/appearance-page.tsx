/**
 * 外观设置页（Fix2/3/4 重构）：
 * - 两组：「系统配色」（内置三档，不可编辑）+「我的配色」（用户创建，可删除）
 * - 「新增配色」按钮直接打开主题编辑器（不跳插件中心）
 * - 文案全部改为用户语言
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTheme, type BuiltinTheme } from "@/hooks/use-theme";
import { invokeCommand } from "@/hooks/use-invoke";
import { listSessionPlugins } from "@/features/session-kernel/plugins/registry";
import { subscribeComposed, composedVersion } from "@/features/session-kernel/capabilities/composition/loader";
import { cn } from "@/lib/utils";
import { Check, Plus, Trash2 } from "lucide-react";
import { PluginThemeWizard } from "./plugin-theme-wizard";

const SYSTEM_THEMES: Array<{ key: BuiltinTheme; label: string; swatch: string[] }> = [
  { key: "light", label: "浅色", swatch: ["#ffffff", "#f4f4f5", "#3f3f46"] },
  { key: "colorful", label: "彩色", swatch: ["#fdf4ff", "#f0abfc", "#7c3aed"] },
  { key: "dark", label: "暗色", swatch: ["#0b1220", "#1e293b", "#e2e8f0"] },
];

function Swatch({ colors }: { colors: string[] }) {
  return (
    <div className="flex h-8 w-full overflow-hidden rounded-md border border-border/40">
      {colors.map((c, i) => (<span key={i} className="flex-1" style={{ backgroundColor: c }} />))}
    </div>
  );
}

export function AppearancePage() {
  const { theme, setTheme } = useTheme();
  useSyncExternalStore(subscribeComposed, composedVersion, () => 0);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [enabledIds, setEnabledIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const list = await invokeCommand<{ plugins: Array<{ id: string; enabled: boolean }> }>("plugin_list");
        if (alive) setEnabledIds(new Set((list.plugins ?? []).filter((p) => p.enabled).map((p) => p.id)));
      } catch { if (alive) setEnabledIds(null); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [refreshKey]);

  const myThemes = listSessionPlugins().filter(
    (p) => p.theme && (!enabledIds || enabledIds.has(p.id)),
  );

  const deleteTheme = async (id: string) => {
    try {
      await invokeCommand("composed_plugin_delete", { id });
      setRefreshKey((k) => k + 1);
      if (theme === id) setTheme("dark");
    } catch { /* 系统件不可删 */ }
  };

  return (
    <div className="space-y-6 p-1">
      <div>
        <h3 className="text-base font-semibold">外观</h3>
        <p className="mt-1 text-xs text-muted-foreground">选择你喜欢的界面配色，或创建自己的配色方案。</p>
      </div>

      {/* 系统配色 */}
      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">系统配色</div>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
          {SYSTEM_THEMES.map((meta) => {
            const active = theme === meta.key;
            return (
              <button key={meta.key} type="button" onClick={() => setTheme(meta.key)}
                className={cn("rounded-lg border p-3 text-left transition-colors",
                  active ? "border-primary" : "border-border/50 hover:border-border")}>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm font-medium">{meta.label}</span>
                  {active && <Check className="h-3.5 w-3.5 text-primary" />}
                </div>
                <Swatch colors={meta.swatch} />
              </button>
            );
          })}
        </div>
      </div>

      {/* 我的配色 */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">我的配色</span>
          <button type="button" onClick={() => setWizardOpen(true)}
            className="flex items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1 text-xs text-primary hover:bg-primary/10">
            <Plus className="h-3.5 w-3.5" />
            新增配色
          </button>
        </div>
        {myThemes.length > 0 ? (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
            {myThemes.map((p) => {
              const active = theme === p.id;
              const swatch = p.theme?.preview?.length ? p.theme.preview : ["#333", "#555", "#999"];
              return (
                <div key={p.id}
                  className={cn("group relative rounded-lg border p-3 text-left transition-colors",
                    active ? "border-primary" : "border-border/50 hover:border-border")}>
                  <button type="button" onClick={() => setTheme(p.id)} className="w-full text-left">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="truncate text-sm font-medium">{p.displayNameFallback}</span>
                      {active && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                    </div>
                    <Swatch colors={swatch} />
                  </button>
                  {/* 删除按钮（hover 显示） */}
                  {!p.id.includes("midnight") && (
                    <button type="button" onClick={() => void deleteTheme(p.id)}
                      className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground/0 transition-colors hover:bg-destructive/10 hover:text-destructive group-hover:text-muted-foreground/50"
                      title="删除此配色">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/40 p-6 text-center">
            <p className="text-xs text-muted-foreground">还没有自定义配色</p>
            <button type="button" onClick={() => setWizardOpen(true)}
              className="mt-2 flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground mx-auto">
              <Plus className="h-3.5 w-3.5" />
              创建第一个配色
            </button>
          </div>
        )}
      </div>

      {/* 主题编辑器 */}
      <PluginThemeWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCreated={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  );
}
