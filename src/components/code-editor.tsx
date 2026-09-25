/**
 * 代码编辑器（v0.9.5 需求1（原需求26）2a）：CodeMirror 6 懒加载封装。
 *
 * - **懒加载**（风险表：编辑器仅在向导打开时加载，不影响首屏体积）——
 *   React.lazy 包 @uiw/react-codemirror；
 * - **实时语法校验**：@codemirror/linter 波浪线 + 侧边槽标记（acorn 解析）；
 * - **契约校验**（JishuPlugin.register 形状/version/component）——与语法
 *   同通道计算，经 bottomErrors 回调供底部错误面板显示（行号+原因）；
 * - **只读模式**支持（查看安装的 component.js）。
 */
import { Suspense, useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { lazy } from "react";
import { Loader2 } from "lucide-react";
import { validateComponentJs } from "@/features/session-kernel/capabilities/composition/code-validate";

const CodeMirror = lazy(() => import("@uiw/react-codemirror"));

/** 主题接入（编辑器深浅色跟随应用）：@uiw 的 oneDark 仅暗色，默认亮色。 */
async function loadExtensions() {
  const { javascript } = await import("@codemirror/lang-javascript");
  const { linter, lintGutter } = await import("@codemirror/lint");
  return { javascript, linter, lintGutter };
}

export interface CodeEditorProps {
  value: string;
  onChange?: (next: string) => void;
  /** 提供 JishuPlugin 契约校验（混合插件向导）。 */
  pluginId?: string;
  /** 只读（查看态）。 */
  readOnly?: boolean;
  height?: string;
  /** 底部错误面板渲染（默认内建：语法红 + 契约黄）。 */
  bottomErrors?: (syntax: Array<{ line: number; col: number; message: string }>, contract: string[]) => ReactNode;
  placeholder?: string;
}

export function CodeEditor({
  value,
  onChange,
  pluginId,
  readOnly = false,
  height = "260px",
  bottomErrors,
  placeholder,
}: CodeEditorProps) {
  const [exts, setExts] = useState<Awaited<ReturnType<typeof loadExtensions>> | null>(null);
  // 最新校验结果（底部面板数据源；linter 波浪线另经扩展渲染）。
  const [validation, setValidation] = useState(() => validateComponentJs(value, { pluginId }));

  const runValidation = useCallback(
    (source: string) => {
      const result = validateComponentJs(source, { pluginId });
      setValidation(result);
      return result;
    },
    [pluginId],
  );

  const extensions = useMemo(() => {
    if (!exts) return [];
    const js = exts.javascript({ jsx: false, typescript: false });
    if (!pluginId && readOnly) return [js];
    // linter：语法错误 → 红波浪线；契约错误 → 警告级（首行锚定）。
    const lint = exts.linter((view) => {
      const source = view.state.doc.toString();
      const r = runValidation(source);
      const diagnostics: Array<{ from: number; to: number; severity: "error" | "warning"; message: string }> = r.syntax.map((s) => ({
        from: Math.min(Math.max(0, view.state.doc.line(s.line).from + s.col - 1), view.state.doc.length),
        to: Math.min(view.state.doc.line(s.line).to, view.state.doc.length),
        severity: "error" as const,
        message: s.message,
      }));
      for (const c of r.contract) {
        diagnostics.push({
          from: 0,
          to: Math.min(10, view.state.doc.length),
          severity: "warning" as const,
          message: c,
        });
      }
      return diagnostics;
    });
    return pluginId || !readOnly ? [js, lint, exts.lintGutter()] : [js];
  }, [exts, pluginId, readOnly, runValidation]);

  if (exts === null) {
    void loadExtensions().then(setExts);
  }

  const errorsNode = bottomErrors ? (
    bottomErrors(validation.syntax, validation.contract)
  ) : (
    <DefaultErrorPanel syntax={validation.syntax} contract={validation.contract} />
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="overflow-hidden rounded-md border border-border">
        <Suspense
          fallback={
            <div className="flex h-[200px] items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载编辑器…
            </div>
          }
        >
          {exts !== null && (
            <CodeMirror
              value={value}
              height={height}
              extensions={extensions}
              readOnly={readOnly}
              placeholder={placeholder}
              basicSetup={{ foldGutter: false, highlightActiveLine: !readOnly }}
              onChange={(next: string) => {
                onChange?.(next);
                runValidation(next);
              }}
            />
          )}
        </Suspense>
      </div>
      {errorsNode}
    </div>
  );
}

/** 默认底部错误面板：语法（行号+原因，红）+ 契约（黄）。 */
function DefaultErrorPanel({
  syntax,
  contract,
}: {
  syntax: Array<{ line: number; col: number; message: string }>;
  contract: string[];
}) {
  if (syntax.length === 0 && contract.length === 0) {
    return (
      <div className="px-1 text-[11px] text-emerald-600">✓ 语法正确 · 契约完整</div>
    );
  }
  return (
    <div className="max-h-28 space-y-0.5 overflow-y-auto rounded-md border border-border/40 bg-muted/20 px-2 py-1.5 font-mono text-[11px]">
      {syntax.map((s, i) => (
        <div key={`s${i}`} className="text-destructive">
          ❌ 第 {s.line} 行 第 {s.col} 列：{s.message}
        </div>
      ))}
      {contract.map((c, i) => (
        <div key={`c${i}`} className="text-amber-600">
          ⚠ {c}
        </div>
      ))}
    </div>
  );
}
