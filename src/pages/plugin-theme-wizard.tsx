/**
 * 需求14 补齐：主题插件可视化自定义器——用户不用写代码就能做出完整自定义主题。
 * 支持：全部颜色令牌（含强调色/文字色/边框色）、背景图上传（cover/contain/tile）、
 * 字号调节、自定义 CSS 高级区。实时预览 + 一键保存安装。
 */
import { useState, useMemo, useRef } from "react";
import { UniModal } from "@/components/ui/uni-modal";
import { Button } from "@/components/ui/button";
import { invokeCommand } from "@/hooks/use-invoke";
import { Palette, Check, Loader2, Image, Type, Code2, Upload, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { slugify } from "./plugin-wizard-utils";

type BuiltinTheme = "light" | "dark";
type ColorKey =
  | "background" | "foreground" | "primary"
  | "layer0" | "layer1" | "layer2" | "layer3" | "layer4"
  | "userBg" | "assistantBg" | "thinkingBg"
  | "border";

type BgFit = "cover" | "contain" | "repeat";

interface ThemeConfig {
  name: string;
  base: BuiltinTheme;
  colors: Record<ColorKey, string>;
  bgImage: { name: string; dataUrl: string } | null;
  bgFit: BgFit;
  bgOpacity: number; // 0~1 背景图不透明度（叠加在底色上）
  fontSize: number; // px, 基础字号
  customCss: string;
}

const COLOR_GROUPS: Array<{ title: string; fields: Array<{ key: ColorKey; label: string; cssVar: string }> }> = [
  { title: "基础", fields: [
    { key: "background", label: "全局底色", cssVar: "--color-background" },
    { key: "foreground", label: "文字色", cssVar: "--color-foreground" },
    { key: "primary", label: "强调色（按钮/链接）", cssVar: "--color-primary" },
    { key: "border", label: "边框色", cssVar: "--color-border" },
  ]},
  { title: "层级面", fields: [
    { key: "layer0", label: "侧栏", cssVar: "--color-layer-0" },
    { key: "layer1", label: "面板", cssVar: "--color-layer-1" },
    { key: "layer2", label: "卡片", cssVar: "--color-layer-2" },
    { key: "layer3", label: "弹窗", cssVar: "--color-layer-3" },
    { key: "layer4", label: "顶层", cssVar: "--color-layer-4" },
  ]},
  { title: "消息气泡", fields: [
    { key: "userBg", label: "用户消息", cssVar: "--message-user-bg" },
    { key: "assistantBg", label: "AI 回复", cssVar: "--message-assistant-bg" },
    { key: "thinkingBg", label: "思考过程", cssVar: "--message-thinking-bg" },
  ]},
];

const ALL_COLOR_FIELDS = COLOR_GROUPS.flatMap((g) => g.fields);

const PRESETS: Array<{ name: string; base: BuiltinTheme; colors: Partial<Record<ColorKey, string>> }> = [
  { name: "森林绿", base: "dark", colors: {
    background: "#0a1f14", layer0: "#0e2818", layer1: "#123524", layer2: "#1a4632", layer3: "#235840", layer4: "#2d6b4f",
    userBg: "#1f5138", assistantBg: "#10281b", thinkingBg: "#0d2216",
    foreground: "#e2e8f0", primary: "#22c55e", border: "#1a3a28",
  }},
  { name: "海洋蓝", base: "dark", colors: {
    background: "#0b1220", layer0: "#0f172a", layer1: "#1e293b", layer2: "#273549", layer3: "#33415c", layer4: "#3f5075",
    userBg: "#1d4ed8", assistantBg: "#111c31", thinkingBg: "#0e1728",
    foreground: "#e2e8f0", primary: "#3b82f6", border: "#1e293b",
  }},
  { name: "暖棕", base: "dark", colors: {
    background: "#1a120b", layer0: "#231a10", layer1: "#2d2218", layer2: "#382b1e", layer3: "#453626", layer4: "#52422f",
    userBg: "#8b5a2b", assistantBg: "#251c12", thinkingBg: "#1e1710",
    foreground: "#e8dcc8", primary: "#d97706", border: "#382b1e",
  }},
  { name: "粉紫", base: "dark", colors: {
    background: "#1a0a1e", layer0: "#220f28", layer1: "#2d1440", layer2: "#3a1a52", layer3: "#472066", layer4: "#54267a",
    userBg: "#7c3aed", assistantBg: "#251230", thinkingBg: "#1e0e28",
    foreground: "#e2d4f0", primary: "#a855f7", border: "#2d1440",
  }},
  { name: "米白", base: "light", colors: {
    background: "#faf5eb", layer0: "#f0e8d8", layer1: "#e8dcc8", layer2: "#ddd0b8", layer3: "#d2c5a8", layer4: "#c7ba9e",
    userBg: "#d4a574", assistantBg: "#f5eee0", thinkingBg: "#ede5d5",
    foreground: "#292524", primary: "#92400e", border: "#ddd0b8",
  }},
  { name: "纯黑", base: "dark", colors: {
    background: "#000000", layer0: "#0a0a0a", layer1: "#141414", layer2: "#1e1e1e", layer3: "#282828", layer4: "#323232",
    userBg: "#1a1a1a", assistantBg: "#0f0f0f", thinkingBg: "#080808",
    foreground: "#ffffff", primary: "#6366f1", border: "#1e1e1e",
  }},
];

const DEFAULT_CONFIG: ThemeConfig = {
  name: "",
  base: "dark",
  colors: {
    background: "#0b1220", foreground: "#e2e8f0", primary: "#3b82f6", border: "#1e293b",
    layer0: "#0f172a", layer1: "#1e293b", layer2: "#273549", layer3: "#33415c", layer4: "#3f5075",
    userBg: "#1d4ed8", assistantBg: "#111c31", thinkingBg: "#0e1728",
  },
  bgImage: null,
  bgFit: "cover",
  bgOpacity: 0.3,
  fontSize: 14,
  customCss: "",
};

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 py-1">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
        className="h-6 w-8 shrink-0 cursor-pointer rounded border border-border/60 bg-transparent" />
      <span className="w-28 shrink-0 text-xs text-foreground/80">{label}</span>
      <code className="ml-auto font-mono text-[10px] text-muted-foreground">{value}</code>
    </label>
  );
}

export function PluginThemeWizard({ open, onOpenChange, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void;
}) {
  const [cfg, setCfg] = useState<ThemeConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [tab, setTab] = useState<"colors" | "bg" | "font" | "css">("colors");
  const fileRef = useRef<HTMLInputElement>(null);

  const id = useMemo(() => {
    const slug = slugify(cfg.name || "my-theme", "my-theme").replace(/[^a-zA-Z0-9-]/g, "");
    return `session.theme-${slug || Date.now().toString(36)}`;
  }, [cfg.name]);

  const set = (k: ColorKey, v: string) => setCfg((p) => ({ ...p, colors: { ...p.colors, [k]: v } }));

  const cssText = useMemo(() => {
    const lines: string[] = [`[data-jishu-theme="${id}"] {`];
    for (const f of ALL_COLOR_FIELDS) {
      lines.push(`  ${f.cssVar}: ${cfg.colors[f.key]};`);
    }
    if (cfg.bgImage) {
      lines.push(`  background-image: linear-gradient(rgba(0,0,0,${1 - cfg.bgOpacity}), rgba(0,0,0,${1 - cfg.bgOpacity})), url(@file:${cfg.bgImage.name});`);
      lines.push(`  background-size: ${cfg.bgFit};`);
      lines.push(`  background-position: center;`);
      if (cfg.bgFit === "repeat") lines.push(`  background-repeat: repeat;`);
    }
    if (cfg.fontSize !== 14) {
      lines.push(`  font-size: ${cfg.fontSize}px;`);
    }
    lines.push("}");
    if (cfg.customCss.trim()) {
      lines.push("", `/* 自定义 CSS */`, cfg.customCss.trim());
    }
    return lines.join("\n");
  }, [id, cfg]);

  const tomlText = useMemo(() => {
    return [
      "[plugin]", `id = "${id}"`, `name = "${cfg.name || "我的主题"}"`,
      `description = "自定义主题"`, 'kind = "session-composed"', 'category = "appearance"',
      "", "[theme]", 'css = "@file:theme.css"', `base = "${cfg.base}"`,
      `preview = ["${cfg.colors.background}", "${cfg.colors.layer1}", "${cfg.colors.primary}"]`,
      "", "[render]", 'mount = "app-theme"',
    ].join("\n");
  }, [id, cfg]);

  const save = async () => {
    if (!cfg.name.trim()) { setError("请输入主题名称"); return; }
    setSaving(true); setError(null);
    try {
      await invokeCommand("composed_plugin_save", { id, toml: tomlText });
      await invokeCommand("plugin_write_theme_css", { pluginId: id, css: cssText });
      if (cfg.bgImage?.dataUrl) {
        const base64 = cfg.bgImage.dataUrl.split(",")[1];
        await invokeCommand("plugin_save_theme_asset", { pluginId: id, fileName: cfg.bgImage.name, base64 });
      }
      setDone(true); onCreated();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };

  const pickImage = () => fileRef.current?.click();
  const onImagePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCfg((p) => ({ ...p, bgImage: { name: file.name, dataUrl: reader.result as string } }));
    };
    reader.readAsDataURL(file);
  };

  const applyPreset = (p: typeof PRESETS[0]) => {
    setCfg((prev) => ({ ...prev, base: p.base, colors: { ...DEFAULT_CONFIG.colors, ...p.colors } }));
    if (!cfg.name.trim()) setCfg((prev) => ({ ...prev, name: p.name }));
  };

  if (!open) return null;
  const c = cfg.colors;

  return (
    <UniModal open={open} onClose={() => onOpenChange(false)} className="w-[min(900px,96vw)] max-h-[90vh]" label="自定义主题">
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {done ? (
          <div className="flex flex-col items-center gap-4 py-10">
            <Check className="h-12 w-12 text-primary" />
            <div className="text-sm font-medium">主题「{cfg.name}」已创建</div>
            <p className="text-xs text-muted-foreground">到 管理→外观 选中它即可生效</p>
            <Button onClick={() => { setDone(false); onOpenChange(false); }}>知道了</Button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* 名称+基座+预设 */}
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[140px]">
                <label className="text-xs text-muted-foreground">主题名称 *</label>
                <input value={cfg.name} onChange={(e) => setCfg((p) => ({ ...p, name: e.target.value }))}
                  placeholder="如：森林绿" className="mt-1 w-full rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-sm" />
              </div>
              <div className="flex gap-1">
                {(["dark","light"] as const).map((b) => (
                  <button key={b} type="button" onClick={() => setCfg((p) => ({ ...p, base: b }))}
                    className={cn("rounded-md border px-3 py-1.5 text-xs", cfg.base === b ? "border-primary bg-primary/10 text-primary" : "border-border/60 text-muted-foreground")}>
                    {b === "dark" ? "暗色基座" : "浅色基座"}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button key={p.name} type="button" onClick={() => applyPreset(p)}
                  className="flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-xs hover:border-primary/50">
                  <span className="flex h-3.5 w-8 overflow-hidden rounded-sm">
                    {[p.colors.background, p.colors.layer1, p.colors.primary].map((col, i) => (
                      <span key={i} className="flex-1" style={{ backgroundColor: col }} />
                    ))}
                  </span>
                  {p.name}
                </button>
              ))}
            </div>

            {/* Tab 切换 */}
            <div className="flex gap-1 border-b border-border/40 pb-2">
              {([
                { k: "colors", icon: Palette, label: "颜色" },
                { k: "bg", icon: Image, label: "背景图" },
                { k: "font", icon: Type, label: "字号" },
                { k: "css", icon: Code2, label: "自定义CSS" },
              ] as const).map(({ k, icon: Icon, label }) => (
                <button key={k} type="button" onClick={() => setTab(k)}
                  className={cn("flex items-center gap-1 rounded-md px-3 py-1.5 text-xs", tab === k ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground")}>
                  <Icon className="h-3.5 w-3.5" />{label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/* 左：编辑区 */}
              <div className="rounded-lg border border-border/40 p-3 min-h-[280px]">
                {tab === "colors" && (
                  <div className="space-y-2">
                    {COLOR_GROUPS.map((g) => (
                      <div key={g.title}>
                        <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{g.title}</div>
                        {g.fields.map((f) => (
                          <ColorRow key={f.key} label={f.label} value={c[f.key]} onChange={(v) => set(f.key, v)} />
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                {tab === "bg" && (
                  <div className="space-y-3">
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onImagePicked} />
                    {cfg.bgImage ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <img src={cfg.bgImage.dataUrl} className="h-16 w-24 rounded object-cover" alt="" />
                          <div className="flex-1 text-xs text-muted-foreground">{cfg.bgImage.name}</div>
                          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setCfg((p) => ({ ...p, bgImage: null }))}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">显示方式</div>
                          <div className="mt-1 flex gap-1">
                            {(["cover","contain","repeat"] as const).map((f) => (
                              <button key={f} type="button" onClick={() => setCfg((p) => ({ ...p, bgFit: f }))}
                                className={cn("rounded border px-2 py-1 text-xs", cfg.bgFit === f ? "border-primary text-primary" : "border-border/60 text-muted-foreground")}>
                                {f === "cover" ? "铺满" : f === "contain" ? "适应" : "平铺"}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">不透明度：{Math.round(cfg.bgOpacity * 100)}%</div>
                          <input type="range" min="0.05" max="1" step="0.05" value={cfg.bgOpacity}
                            onChange={(e) => setCfg((p) => ({ ...p, bgOpacity: Number(e.target.value) }))}
                            className="mt-1 w-full" />
                        </div>
                      </div>
                    ) : (
                      <button type="button" onClick={pickImage}
                        className="flex h-28 w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border/50 text-muted-foreground hover:border-primary/50">
                        <Upload className="h-6 w-6" />
                        <span className="text-xs">点击上传背景图片</span>
                        <span className="text-[10px] text-muted-foreground/50">支持 jpg/png/webp</span>
                      </button>
                    )}
                  </div>
                )}
                {tab === "font" && (
                  <div className="space-y-3 py-4">
                    <div>
                      <div className="text-xs text-muted-foreground">基础字号：{cfg.fontSize}px</div>
                      <input type="range" min="12" max="18" step="1" value={cfg.fontSize}
                        onChange={(e) => setCfg((p) => ({ ...p, fontSize: Number(e.target.value) }))}
                        className="mt-2 w-full" />
                      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                        <span>12px 小</span><span>14px 默认</span><span>18px 大</span>
                      </div>
                    </div>
                  </div>
                )}
                {tab === "css" && (
                  <div className="space-y-2">
                    <div className="text-xs text-muted-foreground">高级：直接写 CSS 追加到主题（选择器已限定 `[data-jishu-theme="{id}"]` 内）</div>
                    <textarea value={cfg.customCss} onChange={(e) => setCfg((p) => ({ ...p, customCss: e.target.value }))}
                      placeholder={`/* 例：给消息气泡加圆角 */\n[data-jishu-theme="${id}"] .message-bubble {\n  border-radius: 16px;\n}`}
                      rows={10} className="w-full rounded-md border border-border/60 bg-background p-2 font-mono text-xs" />
                  </div>
                )}
              </div>

              {/* 右：实时预览 */}
              <div className="rounded-lg border border-border/40 p-3 overflow-hidden relative"
                style={{ backgroundColor: c.background, backgroundImage: cfg.bgImage ? `linear-gradient(rgba(0,0,0,${1-cfg.bgOpacity}),rgba(0,0,0,${1-cfg.bgOpacity})),url(${cfg.bgImage.dataUrl})` : undefined, backgroundSize: cfg.bgFit === "repeat" ? "auto" : cfg.bgFit, backgroundPosition: "center" }}>
                <div className="mb-2 text-xs font-semibold" style={{ color: c.foreground, fontSize: `${cfg.fontSize}px` }}>实时预览</div>
                <div className="mb-2 rounded-md p-2" style={{ backgroundColor: c.layer0, border: `1px solid ${c.border}` }}>
                  <div style={{ color: c.foreground, opacity: 0.6, fontSize: `${cfg.fontSize * 0.8}px` }}>侧栏 · 会话列表</div>
                </div>
                <div className="mb-2 rounded-md p-2" style={{ backgroundColor: c.layer1, border: `1px solid ${c.border}` }}>
                  <div style={{ color: c.foreground, opacity: 0.7, fontSize: `${cfg.fontSize * 0.85}px` }}>面板 · 会话内容区</div>
                </div>
                <div className="space-y-1.5">
                  <div className="max-w-[180px] rounded-lg px-3 py-2 text-xs" style={{ backgroundColor: c.userBg, color: "#fff", fontSize: `${cfg.fontSize * 0.9}px` }}>用户消息</div>
                  <div className="max-w-[180px] rounded-lg px-3 py-2 text-xs" style={{ backgroundColor: c.assistantBg, color: c.foreground, fontSize: `${cfg.fontSize * 0.9}px` }}>AI 回复消息内容</div>
                  <div className="max-w-[180px] rounded-lg px-3 py-2 text-xs italic" style={{ backgroundColor: c.thinkingBg, color: c.foreground, opacity: 0.7, fontSize: `${cfg.fontSize * 0.8}px` }}>思考过程...</div>
                </div>
                <div className="mt-2 flex gap-2">
                  <span className="rounded-md px-2 py-1 text-xs" style={{ backgroundColor: c.primary, color: "#fff" }}>主要按钮</span>
                  <span className="rounded-md border px-2 py-1 text-xs" style={{ borderColor: c.border, color: c.foreground }}>次要按钮</span>
                </div>
                <div className="mt-2 rounded-md p-2" style={{ backgroundColor: c.layer2, border: `1px solid ${c.border}` }}>
                  <div style={{ color: c.foreground, opacity: 0.5, fontSize: `${cfg.fontSize * 0.75}px` }}>卡片 / 代码块</div>
                </div>
              </div>
            </div>

            {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>}
            <div className="flex items-center justify-between">
              <code className="text-[10px] text-muted-foreground/50">{id}</code>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
                <Button size="sm" disabled={saving || !cfg.name.trim()} onClick={() => void save()}>
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
