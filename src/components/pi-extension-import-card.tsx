/**
 * 智能体扩展导入与发现卡（v0.9.5 需求1（原需求26）V4-P7）。
 *
 * 层一自动检测（7a）：启动时扫描一次 extensions/ 的未注册 .ts → 提示卡
 * 「发现新智能体扩展，是否启用？」（查看摘要 / 启用 / 忽略 / 稍后处理）
 * ——不引入新轮询。层二导入按钮（7c）：文件选择 → 摘要确认 → 复制
 * （默认不启用）。安全边界（7b，评审 P1-7）：摘要区分「静态发现的能力」
 * 与「未发现的潜在风险」两栏 + 不可绕过的兜底警告 + 已知绕过面声明。
 * 三轮评审 C28 修复：模态加「稍后处理」逃生口（关闭本次提示、下次启动
 * 再扫）；扫描/启用/忽略失败不再静默或未处理，给出可见错误态。
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import i18n from "@/i18n";
import { ShieldAlert, Check, X, FileCode2, Eye } from "lucide-react";
import { invokeCommand } from "@/hooks/use-invoke";

interface ExtensionSummary {
  tools: string[];
  commands: string[];
  events: string[];
  file_ops: boolean;
  network: boolean;
  subprocess: boolean;
  has_default_export: boolean;
}

interface UnregisteredExtension {
  file_name: string;
  path: string;
  size: number;
  summary: ExtensionSummary;
}

export function PiExtensionImportCard() {
  const [discovered, setDiscovered] = useState<UnregisteredExtension[]>([]);
  const [detail, setDetail] = useState<UnregisteredExtension | null>(null);
  const [notes, setNotes] = useState<{ arbitraryCodeWarning: string; knownBypassSurface: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // 三轮评审 C28：稍后处理（本次会话不再打扰，下次启动重新扫描）与错误态。
  const [dismissed, setDismissed] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // 7a：启动扫描一次（+ 手动重扫入口经 plugins-changed 后不自动——设计：
  // 启动一次 + 手动刷新，不引入新轮询）。
  useEffect(() => {
    void (async () => {
      try {
        const [found, safety] = await Promise.all([
          invokeCommand<UnregisteredExtension[]>("pi_extension_scan"),
          invokeCommand<{ arbitraryCodeWarning: string; knownBypassSurface: string }>("pi_extension_safety_notes"),
        ]);
        setDiscovered(found ?? []);
        setNotes(safety);
      } catch {
        // 命令不存在（老后端）——静默
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const found = await invokeCommand<UnregisteredExtension[]>("pi_extension_scan");
      setDiscovered(found ?? []);
      setScanError(null);
    } catch (err) {
      // 扫描失败不静默吞——发现卡给出可见错误态（三轮评审 C28）。
      setScanError(String(err));
    }
  }, []);

  const enable = useCallback(async (fileName: string): Promise<void> => {
    setBusy(fileName);
    try {
      await invokeCommand("pi_extension_enable", { fileName });
      setDiscovered((prev) => prev.filter((d) => d.file_name !== fileName));
      setDetail(null);
      setScanError(null);
    } catch (err) {
      setScanError(i18n.t("extImport.enableFailed", { err: String(err), defaultValue: "" }));
    } finally {
      setBusy(null);
    }
  }, []);

  const ignore = useCallback(async (fileName: string): Promise<void> => {
    setBusy(fileName);
    try {
      await invokeCommand("pi_extension_ignore", { fileName });
      setDiscovered((prev) => prev.filter((d) => d.file_name !== fileName));
      setDetail(null);
      setScanError(null);
    } catch (err) {
      setScanError(i18n.t("extImport.ignoreFailed", { err: String(err), defaultValue: "" }));
    } finally {
      setBusy(null);
    }
  }, []);

  if (discovered.length === 0 || dismissed) return null;
  const current = detail ?? discovered[0];

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[min(520px,92vw)] rounded-xl border border-amber-500/40 bg-background p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground">
              {discovered.length > 1 ? i18n.t("extImport.foundMany", { count: discovered.length, defaultValue: "" }) : i18n.t("extImport.foundOne", { defaultValue: "" })}
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{current.path}</div>

            {/* 静态发现的能力（7b 两栏之一） */}
            <div className="mt-3 rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-[11px] leading-relaxed">
              <div className="font-medium text-foreground/80">{i18n.t("extImport.capabilities", { defaultValue: "" })}</div>
              <div className="mt-1 space-y-0.5 text-muted-foreground">
                {current.summary.tools.length > 0 && <div>{i18n.t("extImport.tools", { list: current.summary.tools.join("、"), defaultValue: "" })}</div>}
                {current.summary.commands.length > 0 && <div>{i18n.t("extImport.commands", { list: current.summary.commands.join("、"), defaultValue: "" })}</div>}
                {current.summary.events.length > 0 && <div>{i18n.t("extImport.events", { list: current.summary.events.join("、"), defaultValue: "" })}</div>}
                {current.summary.tools.length + current.summary.commands.length + current.summary.events.length === 0 && (
                  <div>{i18n.t("extImport.noneRegistered", { defaultValue: "" })}</div>
                )}
              </div>
            </div>
            {/* 未发现的潜在风险（两栏之二） */}
            <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed">
              <div className="font-medium text-amber-600">{i18n.t("extImport.risks", { defaultValue: "" })}</div>
              {current.summary.file_ops && <div>{i18n.t("extImport.riskFileOps", { defaultValue: "" })}</div>}
              {current.summary.network && <div>{i18n.t("extImport.riskNetwork", { defaultValue: "" })}</div>}
              {current.summary.subprocess && <div>{i18n.t("extImport.riskSubprocess", { defaultValue: "" })}</div>}
              {!current.summary.file_ops && !current.summary.network && !current.summary.subprocess && (
                <div className="text-muted-foreground">{i18n.t("extImport.noRisksFound", { defaultValue: "" })}</div>
              )}
              <div className="mt-1 font-medium text-destructive">{notes?.arbitraryCodeWarning}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground/70">{notes?.knownBypassSurface}</div>
            </div>

            {scanError && (
              <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                {scanError}
              </div>
            )}

            {discovered.length > 1 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {discovered.map((d) => (
                  <button
                    key={d.file_name}
                    type="button"
                    onClick={() => setDetail(d)}
                    className={
                      "rounded-md border px-2 py-0.5 font-mono text-[10px] " +
                      (d.file_name === current.file_name
                        ? "border-primary/60 bg-primary/5 text-foreground"
                        : "border-border/60 text-muted-foreground hover:text-foreground")
                    }
                  >
                    <Eye className="mr-1 inline h-3 w-3" />
                    {d.file_name}
                  </button>
                ))}
              </div>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                disabled={busy === current.file_name}
                onClick={() => void enable(current.file_name)}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                {i18n.t("extImport.enable", { defaultValue: "" })}
              </button>
              <button
                type="button"
                disabled={busy === current.file_name}
                onClick={() => void ignore(current.file_name)}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
                {i18n.t("extImport.ignore", { defaultValue: "" })}
              </button>
              {/* 三轮评审 C28：模态逃生口——不动文件、不进忽略名单，本次会话
                  不再打扰，下次启动重新扫描提示。 */}
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="ml-auto self-center text-xs text-muted-foreground/70 hover:text-foreground"
              >
                {i18n.t("extImport.later", { defaultValue: "" })}
              </button>
            </div>
          </div>
        </div>
        <button type="button" onClick={() => void refresh()} className="mt-3 flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-foreground">
          <FileCode2 className="h-3 w-3" />
          {i18n.t("extImport.rescan", { defaultValue: "" })}
        </button>
      </div>
    </div>,
    document.body,
  );
}
