import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** 秒数拆成「分钟数 + 不足一分钟的秒数」。 */
export function splitElapsed(totalSeconds: number): { minutes: number; seconds: number } {
  const total = Math.max(0, Math.floor(totalSeconds));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

/**
 * v0.9.8 需求7 补充轮：上下文压缩的已用时间。大上下文的压缩要读入几十万
 * token、可能持续数分钟，界面只有「上下文压缩中…」一行时，用户无从判断它
 * 是在进行还是卡住。每秒刷新一次；计时自带状态，不牵动整条流式消息重渲染。
 */
export function CompactionElapsed({ startedAt }: { startedAt: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const { minutes, seconds } = splitElapsed((now - startedAt) / 1000);
  return (
    <div className="flex justify-center text-[11px] text-muted-foreground tabular-nums">
      {minutes > 0
        ? t("sessions.compactElapsedMinSec", { m: String(minutes), s: String(seconds).padStart(2, "0") })
        : t("sessions.compactElapsedSec", { s: String(seconds) })}
    </div>
  );
}
