// v0.9.0 需求19 测试期迭代：插件图标选择器——info.icon 键从此有真实渲染面
//（此前为纯文本字段，无任何消费方）。注册表 = 精选 lucide 图标；选择器
// 弹层按网格展示图标本身（非编码文本）；未知键回退 Bot。

import { useState } from "react";
import {
  Blocks,
  Bot,
  Brain,
  Cloud,
  Database,
  FileCode,
  GitBranch,
  Globe,
  MessageSquare,
  Package,
  Rocket,
  Search,
  Server,
  Settings,
  Shield,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** 插件图标注册表：manifest info.icon 键 → 图标组件（键即 lucide 图标名，小写）。 */
export const PLUGIN_ICON_REGISTRY: Record<string, LucideIcon> = {
  bot: Bot,
  terminal: Terminal,
  blocks: Blocks,
  sparkles: Sparkles,
  "file-code": FileCode,
  globe: Globe,
  database: Database,
  wrench: Wrench,
  zap: Zap,
  search: Search,
  "git-branch": GitBranch,
  "message-square": MessageSquare,
  settings: Settings,
  shield: Shield,
  rocket: Rocket,
  brain: Brain,
  cloud: Cloud,
  server: Server,
  package: Package,
};

/** 键 → 图标组件；空/未知键回退 Bot。 */
export function resolvePluginIcon(key?: string | null): LucideIcon {
  return (key && PLUGIN_ICON_REGISTRY[key.trim().toLowerCase()]) || Bot;
}

/** 插件行/卡上的图标渲染（plugins 页与选择器共用视觉）。 */
export function PluginIcon({
  icon,
  size = 16,
  className,
}: {
  icon?: string | null;
  size?: number;
  className?: string;
}) {
  const Icon = resolvePluginIcon(icon);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded bg-muted text-muted-foreground",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Icon style={{ width: Math.max(12, size - 4), height: Math.max(12, size - 4) }} />
    </span>
  );
}

/** 图标选择器：触发器显示当前图标本体 + 键名；弹层网格点选。 */
export function IconPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const Current = resolvePluginIcon(value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 text-xs text-left transition-colors hover:bg-accent/45 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Current className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="font-mono">{value || "bot"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="grid grid-cols-6 gap-1">
          {Object.entries(PLUGIN_ICON_REGISTRY).map(([key, Icon]) => (
            <button
              key={key}
              type="button"
              title={key}
              aria-label={key}
              onClick={() => {
                onChange(key);
                setOpen(false);
              }}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-md border transition-colors",
                value === key
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
