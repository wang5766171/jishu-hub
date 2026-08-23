import { HelpCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * v0.8.0 需求10：轻量问号提示，适配高 z 序弹出卡片（如圆环弹层 z-[90]）
 * 内的帮助说明——内容经 Portal 挂载并置于 z-[200]，不会被宿主卡片遮挡
 * （SectionHelp 的 Popover 默认 z-50 会被盖住，故此场景专用本组件）。
 */
export function HelpHint({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="help"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "ml-0.5 inline-flex items-center text-muted-foreground/60 transition-colors hover:text-foreground",
            className,
          )}
        >
          <HelpCircle className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="z-[200] w-72 p-2.5 text-[11px] leading-relaxed"
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}
