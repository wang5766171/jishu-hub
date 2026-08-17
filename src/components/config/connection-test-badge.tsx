// v0.7.4 需求2：连通性测试结果条（R1 供应商添加面板与 R2 claude 配置页共用）。

import { useTranslation } from "react-i18next";
import { CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ConnectionTestResult {
  ok: boolean;
  /** 成功：模型回复摘要；失败：错误信息 */
  text: string;
  /** 成功时的耗时（ms） */
  latencyMs?: number;
}

export function ConnectionTestBadge({ result }: { result: ConnectionTestResult }) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
        result.ok
          ? "border-green-500/40 bg-green-500/10 text-green-400"
          : "border-red-500/40 bg-red-500/10 text-red-300",
      )}
      role="status"
    >
      {result.ok ? (
        <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      ) : (
        <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <span className="font-medium">
          {result.ok ? t("config.testConnectionOk") : t("config.testConnectionFailed")}
        </span>
        {result.latencyMs != null && (
          <span className="ml-2 text-muted-foreground">{result.latencyMs}ms</span>
        )}
        {result.text && (
          <div className="mt-0.5 break-words opacity-80">{result.text}</div>
        )}
      </div>
    </div>
  );
}
