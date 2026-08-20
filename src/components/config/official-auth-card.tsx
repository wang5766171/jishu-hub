// v0.7.6 需求3：官方直连认证卡（claude / codex 直连态右栏）。
// 状态经 agent_official_auth IPC 由 adapter contract 透出（None = 该
// agent 无官方认证概念，不渲染）；「前往认证」经 run_in_terminal 执行
// 官方登录命令（codex login 自动打开浏览器；claude 在 REPL 内 /login）。

import { useTranslation } from "react-i18next";
import { invokeCommand, useInvoke } from "@/hooks/use-invoke";
import { Button } from "@/components/ui/button";
import { CheckCircle2, ExternalLink, ShieldAlert } from "lucide-react";

interface OfficialAuthInfo {
  authenticated: boolean;
  login_command: string;
}

export function OfficialAuthCard({
  agentId,
  /** 认证指引文案键（codex / claude 各自的流程说明）。 */
  hintKey,
}: {
  agentId: string;
  hintKey: string;
}) {
  const { t } = useTranslation();
  // 登录在终端完成后回到本页刷新（重新进入/切换子页触发 refetch）。
  const { data: auth } = useInvoke<OfficialAuthInfo | null>(
    agentId ? "agent_official_auth" : "",
    agentId ? { agentId } : undefined,
  );

  if (!agentId || !auth) return null;
  const isCodexLogin = auth.login_command.startsWith("codex");

  return (
    <div className="space-y-2 rounded-md border border-border/40 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">
          {t("config.officialAuthTitle")}
        </div>
        {auth.authenticated ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />
            {t("config.officialAuthOk")}
          </span>
        ) : (
          <Button
            size="sm"
            className="h-7 shrink-0 text-xs"
            onClick={() =>
              void invokeCommand("run_in_terminal", { commandStr: auth.login_command })
            }
          >
            <ExternalLink className="mr-1 h-3 w-3" />
            {t("config.officialAuthGo")}
          </Button>
        )}
      </div>
      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground/80">
        {!auth.authenticated && <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />}
        {t(hintKey)}
        {!auth.authenticated && isCodexLogin
          ? ` ${t("config.officialAuthRefreshHint")}`
          : ""}
      </p>
    </div>
  );
}
