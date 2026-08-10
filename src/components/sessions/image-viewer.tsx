import { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ImageViewerProps {
  /** 图片地址：data URL 或可加载的 URL。 */
  src: string;
  /** 关闭预览。 */
  onClose: () => void;
  /** 可选的 alt 文本。 */
  alt?: string;
}

/**
 * 统一图片预览器（lightbox）。
 *
 * 用途：发送框缩略图与会话区图片点击后，在应用内全屏预览大图，
 * 替代原先「会话区图片点击用 window.open 在浏览器新窗口打开」的行为。
 *
 * 交互（基础版）：
 * - 深色背景 + 图片自适应居中显示（object-contain，不超出视口）；
 * - 点击图片外的空白背景区域关闭；
 * - 按 ESC 关闭；
 * - 点击图片本身不关闭（避免缩放/查看时误触）；
 * - 滚轮不冒泡，避免关闭后背景意外滚动。
 *
 * 单图预览；多图切换、缩放/平移等能力按需后续扩展。
 */
export function ImageViewer({ src, onClose, alt }: ImageViewerProps) {
  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // 打开预览时锁定背景滚动
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // 点击背景（非图片）关闭；点击图片阻止冒泡。
  const handleBackdropClick = useCallback(() => {
    onClose();
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={alt ?? "image preview"}
        onClick={handleBackdropClick}
        className={cn(
          "fixed inset-0 z-[100] flex items-center justify-center",
          "bg-black/90 animate-in fade-in-0 duration-150",
          "p-4 cursor-zoom-out",
        )}
      >
        {/* 关闭按钮 */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="close"
          className="absolute top-4 right-4 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>

        {/* 图片本身：点击不关闭（阻止冒泡到背景），自适应视口 */}
        <img
          src={src}
          alt={alt ?? ""}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "max-h-full max-w-full object-contain rounded shadow-2xl",
            "animate-in zoom-in-95 duration-150 cursor-default",
          )}
          draggable={false}
        />
      </div>
    ),
    document.body,
  );
}
