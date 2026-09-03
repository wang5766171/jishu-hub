import { cn } from "@/lib/utils";

/**
 * v0.8.0 需求6：iOS 风格加载指示器——12 根短竖线围成圆圈，按序渐隐轮转
 * （animation-delay 逐根错开 1/12 周期，视觉上亮段绕圈走）。用于会话列表
 * 「正在输出」行图标；与刷新的旋转箭头（RotateCw）在形态上彻底区分。
 * 对称图标配 animate-spin 视觉上是不动的，因此必须逐条渐隐实现动效。
 */
export function ActivitySpinner({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-block shrink-0", className)} aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <span
          key={i}
          className="activity-spinner-bar absolute rounded-full bg-current"
          style={{
            transform: `rotate(${i * 30}deg) translateY(-4.5px)`,
            animationDelay: `${(i - 12) * 100}ms`,
          }}
        />
      ))}
    </span>
  );
}
