/**
 * 需求14 补齐（用户裁决「实现GUI主题」）：主题插件可视化向导——用户点几下
 * 选颜色就能做出自定义主题，不依赖 agent 也不需要写代码。
 * 产出 plugin.toml + theme.css → add-hybrid 安装 → 确认卡 → 外观页激活。
 */
import { useState, useMemo } from "react";
import { UniModal } from "@/components/ui/uni-modal";
import { Button } from "@/components/ui/button";
import { invokeCommand } from "@/hooks/use-invoke";
import { Palette, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { slugify } from "./plugin-wizard-utils";

type BuiltinTheme = "light" | "dark";
type ColorKey =
  | "background" | "layer0" | "layer1" | "layer2"
  | "userBg" | "assistantBg" | "thinkingBg";

const COLOR_FIELDS: Array<{ key: ColorKey; label: string; cssVar: string }> = [
  { key: "background", label: "全局底色", cssVar: "--color-background" },
  { key: "layer0", label: "侧栏底色", cssVar: "--color-layer-0" },
  { key: "layer1", label: "面板底色", cssVar: "--color-layer-1" },
  { key: "layer2", label: "卡片底色", cssVar: "--color-layer-2" },
  { key: "userBg", label: "用户气泡", cssVar: "--message-user-bg" },
  { key: "assistantBg", label: "AI 气泡", cssVar: "--message-assistant-bg" },
  { key: "thinkingBg", label: "思考气泡", cssVar: "--message-thinking-bg" },
];

const PRESETS: Array<{ name: string; base: BuiltinTheme; colors: Record<ColorKey, string> }> = [
  { name: "森林绿", base: "dark", colors: {
    background: "#0a1f14", layer0: "#0e2818", layer1: "#123524", layer2: "#1a4632",
    userBg: "#1f5138", assistantBg: "#10281b", thinkingBg: "#0d2216",
  }},
  { name: "海洋蓝", base: "dark", colors: {
    background: "#0b1220", layer0: "#0f172a", layer1: "#1e293b", layer2: "#273549",
    userBg: "#1d4ed8", assistantBg: "#111c31", thinkingBg: "#0e1728",
  }},
  { name: "暖棕", base: "dark", colors: {
    background: "#1a120b", layer0: "#231a10", layer1: "#2d2218", layer2: "#382b1e",
    userBg: "#8b5a2b", assistantBg: "#251c12", thinkingBg: "#1e1710",
  }},
  { name: "粉紫", base: "dark", colors: {
    background: "#1a0a1e", layer0: "#220f28", layer1: "#2d1440", layer2: "#3a1a52",
    userBg: "#7c3aed", assistantBg: "#251230", thinkingBg: "#1e0e28",
  }},
  { name: "米白", base: "light", colors: {
    background: "#faf5eb", layer0: "#f0e8d8", layer1: "#e8dcc8", layer2: "#ddd0b8",
    userBg: "#d4a574", assistantBg: "#f5eee0", thinkingBg: "#ede5d5",
  }},
];

const DEFAULT_COLORS: Record<ColorKey, string> = {
  background: "#0b1220", layer0: "#0f172a", layer1: "#1e293b", layer2: "#273549",
  userBg: "#1d4ed8", assistantBg: "#111c31", thinkingBg: "#0e1728",
};

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 py-1">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-9 shrink-0 cursor-pointer rounded border border-border/60 bg-transparent"
      />
      <span className="w-20 shrink-0 text-xs text-foreground/80">{label}</span>
      <code className="ml-auto font-mono text-[10px] text-muted-foreground">{value}</code>
    </label>
  );
}

function PreviewBubble({ bg, label, fg }: { bg: string; label: string; fg: string }) {
  return (
    <div
      className="max-w-[180px] rounded-lg px-3 py-2 text-xs"
      style={{ backgroundColor: bg, color: fg }}
    >
      {label}
    </div>
  );
}

export function PluginThemeWizard({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [base, setBase] = useState<BuiltinTheme>("dark");
  const [colors, setColors] = useState<Record<ColorKey, string>>(DEFAULT_COLORS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const id = useMemo(() => {
    // 中文/特殊字符 slugify 后可能为空或含非 ASCII——回退时间戳保底。
    const slug = slugify(name || "my-theme", "my-theme").replace(/[^a-zA-Z0-9-]/g, "");
    return `session.theme-${slug || Date.now().toString(36)}`;
  }, [name]);

  const set = (k: ColorKey, v: string) => setColors((p) => ({ ...p, [k]: v }));

  const fg = base === "dark" ? "#e2e8f0" : "#1e293b";

  const cssText = useMemo(() => {
    const vars = COLOR_FIELDS.map((f) => `  ${f.cssVar}: ${colors[f.key]};`).join("\n");
    return `[data-jishu-theme="${id}"] {\n${vars}\n}`;
  }, [id, colors]);

  const tomlText = useMemo(() => {
    return [
      "[plugin]",
      `id = "${id}"`,
      `name = "${name || "我的主题"}"`,
      `description = "GUI 向导创建的自定义主题"`,
      'kind = "session-composed"',
      'category = "appearance"',
      "",
      "[theme]",
      'css = "@file:theme.css"',
      `base = "${base}"`,
      `preview = ["${colors.background}", "${colors.layer1}", "${base === "dark" ? "#e2e8f0" : "#1e293b"}"]`,
      "",
      "[render]",
      'mount = "app-theme"',
    ].join("\n");
  }, [id, name, base, colors]);

  const save = async () => {
    if (!name.trim()) { setError("请输入主题名称"); return; }
    setSaving(true); setError(null);
    try {
      // 主题形态无代码——先建目录+TOML，再写 CSS（不走 hybrid_plugin_save
      // 避免落空 component.js）。确认卡安全阀仍经 composed 路径。
      await invokeCommand("composed_plugin_save", { id, toml: tomlText });
      await invokeCommand("plugin_write_theme_css", { pluginId: id, css: cssText });
      setDone(true);
      onCreated();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const applyPreset = (preset: typeof PRESETS[0]) => {
    setColors(preset.colors);
    setBase(preset.base);
    if (!name.trim()) setName(preset.name);
  };

  if (!open) return null;

  return (
    <UniModal
      open={open}
      onClose={() => { onOpenChange(false); }}
      className="w-[min(760px,94vw)]"
      label="创建主题插件"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {done ? (
          <div className="flex flex-col items-center gap-4 py-10">
            <Check className="h-12 w-12 text-primary" />
            <div className="text-sm font-medium">主题「{name}」已创建</div>
            <p className="text-xs text-muted-foreground">
              已默认禁用（安全阀）——请在插件中心确认卡点「启用」，然后到 管理 → 外观 选中它。
            </p>
            <Button onClick={() => { setDone(false); onOpenChange(false); }}>知道了</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Palette className="h-5 w-5 text-primary" />
              <div>
                <div className="text-sm font-semibold">创建自定义主题</div>
                <div className="text-xs text-muted-foreground">选颜色 → 实时预览 → 保存安装（无需写代码）</div>
              </div>
            </div>

            {/* 名称 + 基座 */}
            <div className="flex flex-wrap gap-3">
              <div className="flex-1 min-w-[160px]">
                <label className="text-xs text-muted-foreground">主题名称 *</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如：森林绿"
                  className="mt-1 w-full rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">基座</label>
                <div className="mt-1 flex gap-1">
                  {(["dark", "light"] as const).map((b) => (
                    <button
                      key={b}
                      type="button"
                      onClick={() => setBase(b)}
                      className={cn(
                        "rounded-md border px-3 py-1.5 text-xs",
                        base === b ? "border-primary bg-primary/10 text-primary" : "border-border/60 text-muted-foreground",
                      )}
                    >
                      {b === "dark" ? "暗色" : "浅色"}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 预设 */}
            <div>
              <div className="mb-1 text-xs text-muted-foreground">快速开始（点预设一键填色）</div>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className="flex items-center gap-1.5 rounded-lg border border-border/50 px-2.5 py-1.5 hover:border-primary/50"
                  >
                    <span className="flex h-4 w-10 overflow-hidden rounded">
                      {Object.values(p.colors).slice(0, 4).map((c, i) => (
                        <span key={i} className="flex-1" style={{ backgroundColor: c }} />
                      ))}
                    </span>
                    <span className="text-xs">{p.name}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 色板编辑 + 预览 */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-border/40 p-3">
                <div className="mb-2 text-xs font-semibold text-foreground/80">调色板</div>
                {COLOR_FIELDS.map((f) => (
                  <ColorRow key={f.key} label={f.label} value={colors[f.key]} onChange={(v) => set(f.key, v)} />
                ))}
              </div>
              <div
                className="rounded-lg border border-border/40 p-3"
                style={{ backgroundColor: colors.background }}
              >
                <div className="mb-2 text-xs font-semibold" style={{ color: fg }}>实时预览</div>
                {/* 侧栏 */}
                <div className="mb-2 rounded-md p-2" style={{ backgroundColor: colors.layer0 }}>
                  <div className="text-[10px]" style={{ color: fg, opacity: 0.6 }}>侧栏 · 会话列表</div>
                </div>
                {/* 面板 */}
                <div className="mb-2 rounded-md p-2" style={{ backgroundColor: colors.layer1 }}>
                  <div className="text-[10px]" style={{ color: fg, opacity: 0.6 }}>面板 · 会话内容区</div>
                </div>
                {/* 气泡 */}
                <div className="space-y-1.5">
                  <PreviewBubble bg={colors.userBg} fg={base === "dark" ? "#fff" : "#fff"} label="用户消息" />
                  <PreviewBubble bg={colors.assistantBg} fg={fg} label="AI 回复消息" />
                  <PreviewBubble bg={colors.thinkingBg} fg={fg} label="思考过程..." />
                </div>
                <div className="mt-2 rounded-md p-2" style={{ backgroundColor: colors.layer2 }}>
                  <div className="text-[10px]" style={{ color: fg, opacity: 0.5 }}>卡片 / 代码块</div>
                </div>
              </div>
            </div>

            {error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}

            <div className="flex items-center justify-between">
              <div className="text-[10px] font-mono text-muted-foreground/50">{id}</div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
                <Button size="sm" disabled={saving || !name.trim()} onClick={() => void save()}>
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  <span className="ml-1">保存并安装</span>
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </UniModal>
  );
}
