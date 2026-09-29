/**
 * UniModal —— 统一弹窗基座（v0.9.5 需求1 GUI 改造 · 批次1）。
 *
 * 背景：插件族弹窗（详情/组合向导/创建入口/混合向导/流水线向导/安装确认）
 * 各自手写 createPortal 外壳——层级（z-70/z-80 混用）、遮罩（有无 blur）、
 * Esc/遮罩点击关闭、尺寸与头部结构不一致（v3 设计「统一弹窗优化」）。
 *
 * 收敛约定（对应 05 留档 GUI 改造）：
 * - 层级统一 z-[80]；遮罩 bg-black/50 + backdrop-blur-sm
 * - Esc 关闭 + 遮罩点击关闭；preventClose=true 时均不关（脏表单保护）
 * - 尺寸档 sm/md/lg/xl（宽度）；fixedHeight 限高（详情类限高滚动），
 *   默认 max-h 内容自适应
 * - UniModalHeader：统一头部（标题 + 副题 + 右槽 + 关闭钮）
 */
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "w-[min(440px,94vw)]",
  md: "w-[min(560px,94vw)]",
  lg: "w-[min(720px,94vw)]",
  xl: "w-[min(920px,94vw)]",
} as const;

export interface UniModalProps {
  open: boolean;
  onClose: () => void;
  /** 脏态保护：true 时 Esc/遮罩点击不关闭（详情保存场景）。 */
  preventClose?: boolean;
  size?: keyof typeof SIZES;
  /** true = 固定限高 h-[min(80vh,760px)]（内部滚动）；false = 内容自适应（max-h 86vh）。 */
  fixedHeight?: boolean;
  className?: string;
  /** 无障碍标签（缺省用标题）。 */
  label?: string;
  children: ReactNode;
}

export function UniModal({
  open,
  onClose,
  preventClose = false,
  size = "md",
  fixedHeight = false,
  className,
  label,
  children,
}: UniModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !preventClose) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, preventClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-6"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => {
          if (!preventClose) onClose();
        }}
      />
      <div
        className={cn(
          "relative flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl",
          fixedHeight ? "h-[min(80vh,760px)]" : "max-h-[min(86vh,800px)]",
          SIZES[size],
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface UniModalHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** 头部右侧槽（id 回显等，位于关闭钮左侧）。 */
  trailing?: ReactNode;
  onClose: () => void;
  /** 脏态下关闭钮禁用（与 preventClose 同源传参）。 */
  closeDisabled?: boolean;
  /** 头部自定义类（对齐既有各弹窗 py-3.5/py-4 差异）。 */
  className?: string;
}

/** 统一头部：标题 + 副题 + 右槽 + 关闭钮。 */
export function UniModalHeader({
  title,
  subtitle,
  trailing,
  onClose,
  closeDisabled,
  className,
}: UniModalHeaderProps) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between border-b border-border/50 px-5 py-3.5",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold">{title}</div>
        {subtitle ? (
          <div className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</div>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {trailing}
        <button
          type="button"
          title={closeDisabled ? "有未保存修改" : "关闭"}
          aria-label="关闭"
          onClick={onClose}
          disabled={closeDisabled}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
