import { memo } from "react";
import { useTranslation } from "react-i18next";

/**
 * v0.9.4 需求8 测试期展示重构（用户实测：命令与结果混排、结果为原始 JSON、
 * 可读性差）。分区原则：
 *  - 操作区（命令）：$ 前缀 + 完整命令，可换行不截断；
 *  - 结果区（控制台）：等宽纯文本、保留行结构与空行——与自己在终端执行后
 *    的控制台输出一致；error 时红色；超长尾窗截断。
 * output 已在归一化层提取为纯文本（pi AgentToolResult 形态 content[].text）。
 */
export const ShellExecBody = memo(function ShellExecBody({ input, output, error }: { input: Record<string, unknown>; output?: string; error?: string }) {
  const { t } = useTranslation();
  const command = (input.command as string) || "";
  const cwd = input.cwd as string | undefined;
  const hasResult = Boolean(output || error);

  return (
    <div className="text-[0.95em] space-y-2">
      {/* 操作区：完整命令，可换行不截断 */}
      <div className="rounded-[6px] border border-border/40 bg-[var(--tool-card-code-bg)] px-2.5 py-2">
        <div className="flex items-start gap-2">
          <span className="shrink-0 font-mono text-muted-foreground select-none">$</span>
          <code className="font-mono text-[var(--color-foreground)] break-all whitespace-pre-wrap">{command}</code>
        </div>
        {cwd && (
          <div className="mt-1 text-[0.85em] text-muted-foreground font-mono truncate" title={cwd}>
            cwd: {cwd}
          </div>
        )}
      </div>
      {/* 结果区：控制台输出（保留行结构；error 红色；超长尾窗） */}
      {hasResult && (
        <div className="rounded-[6px] border border-border/40 bg-[var(--tool-card-code-bg)] overflow-hidden">
          <div className="px-2.5 pt-1.5 text-[0.78em] font-medium text-muted-foreground flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--icon-success)]" />
            {t("sessions.toolOutputTitle", "执行结果")}
            {output && (
              <span className="font-normal">
                · {t("sessions.toolOutputLines", "{{count}} 行输出", { count: output.split("\n").length })}
              </span>
            )}
          </div>
          <pre
            className={`font-mono text-[0.95em] px-2.5 py-2 m-0 overflow-x-auto max-h-72 overflow-y-auto whitespace-pre ${error ? "text-[var(--tool-error)]" : ""}`}
          >
            {(output ?? "") + (error ? (output ? "\n" : "") + error : "")}
          </pre>
        </div>
      )}
    </div>
  );
});
