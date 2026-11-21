// v0.9.8 需求5（合并版）：装备安装执行器（共享 hook）。
// 从 plugin-market.tsx 抽离，三处消费：市场推荐区弹层 / 首启入门套装 /
// 会话推荐卡。五修继承（02 设计 D5-1）：
// ①取消令牌——cancel() 后剩余项不再发起（进行中单项任其完成）；
// ②重试保历史——retryFailed 按 ref merge，成功 ✓ 保留；
// ③失败原因可见——fail 行携带 error 文本；
// ④安全说明行——含技能项时的提示由消费方 UI 呈现（runner 提供 hasSkill）；
// ⑤类型名精确——kindNameOf 单源映射。
// 执行语义不变：串行、单项失败继续、已装跳过（调用方过滤）。

import { useCallback, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import type { InstallMeta } from "./api";
import { installCommandFor } from "./match";

export type RunState = "pending" | "running" | "ok" | "fail";

export interface RunStatus {
  ref: string;
  state: RunState;
  error?: string;
}

export interface RunnerItem {
  ref: string;
  /** 安装 meta（via 推荐链路来源 / title / tags 理由标签）。 */
  meta?: InstallMeta;
}

export interface RunnerResult {
  statuses: RunStatus[];
  running: boolean;
  /** 是否含技能项（消费方据此渲染安全说明行）。 */
  hasSkill: boolean;
  /** 启动安装（refs 全量；已装项由调用方预先过滤）。 */
  run: (items: RunnerItem[]) => void;
  /** 取消剩余项（进行中单项任其完成）。 */
  cancel: () => void;
  /** 只重试失败项（成功历史 merge 保留）。 */
  retryFailed: () => void;
  /** 完成回调（全量落定：成功/失败汇总后触发一次）。 */
  setOnDone: (cb: (() => void) | null) => void;
}

export function useEquipmentRunner(): RunnerResult {
  const [statuses, setStatuses] = useState<RunStatus[]>([]);
  const [running, setRunning] = useState(false);
  // 取消令牌：自增即作废旧运行（弹层关闭/显式取消）。
  const runToken = useRef(0);
  const itemsRef = useRef<RunnerItem[]>([]);
  const onDoneRef = useRef<(() => void) | null>(null);

  const execute = useCallback(async (items: RunnerItem[], base: RunStatus[]) => {
    const token = ++runToken.current;
    itemsRef.current = items;
    // merge 语义：base 是既有历史（重试时=成功 ✓ 保留），新 ref 从 pending 起。
    let current = base;
    const apply = (fn: (rows: RunStatus[]) => RunStatus[]) => {
      current = fn(current);
      setStatuses(current);
    };
    setRunning(true);
    for (let i = 0; i < items.length; i++) {
      // 取消令牌校验（①：关=真取消——旧运行残留循环不再发起 IPC）。
      if (runToken.current !== token) break;
      const { ref, meta } = items[i];
      apply((rows) =>
        rows.map((r) => (r.ref === ref ? { ...r, state: "running" as const, error: undefined } : r)),
      );
      try {
        const target = installCommandFor(ref);
        if (!target) throw new Error(`unknown ref: ${ref}`);
        await invokeCommand(target.command, { ...target.args, meta: meta ?? { via: "manual" } });
        apply((rows) => rows.map((r) => (r.ref === ref ? { ...r, state: "ok" as const } : r)));
      } catch (e) {
        // ③：失败原因收集（UI 展开渲染）。
        apply((rows) =>
          rows.map((r) => (r.ref === ref ? { ...r, state: "fail" as const, error: String(e) } : r)),
        );
      }
    }
    if (runToken.current === token) {
      setRunning(false);
      onDoneRef.current?.();
    }
  }, []);

  const run = useCallback(
    (items: RunnerItem[]) => {
      const base: RunStatus[] = items.map((i) => ({ ref: i.ref, state: "pending" as const }));
      void execute(items, base);
    },
    [execute],
  );

  const cancel = useCallback(() => {
    // 令牌作废：循环下一轮 break；进行中单项 await 自然完成（不留半装态）。
    runToken.current += 1;
    setRunning(false);
    setStatuses((prev) =>
      prev.map((r) => (r.state === "pending" ? { ...r, state: "fail" as const, error: undefined } : r)),
    );
  }, []);

  const retryFailed = useCallback(() => {
    const failed = statuses.filter((s) => s.state === "fail").map((s) => s.ref);
    if (failed.length === 0) return;
    const items = itemsRef.current.filter((i) => failed.includes(i.ref));
    // ②：merge——成功 ✓ 行保留，失败行重置 pending。
    const base: RunStatus[] = [
      ...statuses.filter((s) => s.state === "ok"),
      ...failed.map((ref) => ({ ref, state: "pending" as const })),
    ];
    void execute(items, base);
  }, [execute, statuses]);

  const setOnDone = useCallback((cb: (() => void) | null) => {
    onDoneRef.current = cb;
  }, []);

  const hasSkill = statuses.some((s) => s.ref.startsWith("skillhub:"));

  return { statuses, running, hasSkill, run, cancel, retryFailed, setOnDone };
}

/** ⑤：类型名精确映射（curated kind → 用户语言；skillhub/pi 前缀判定）。
 * i18n 键复用市场 guideKind 既有四键（plugin/skill/extension/composed）。
 * t 参数用 i18next TFunction 类型（构建脚本严格 i18n 类型下裸函数签名不兼容）。 */
export function kindNameOf(ref: string, kind?: string, t?: TFunction): string {
  const tr = (key: string, d: string) => (t ? t(key, { defaultValue: d }) : d);
  if (ref.startsWith("skillhub:")) return tr("market.guideKindSkill", "技能");
  if (ref.startsWith("pi:")) return tr("market.guideKindExtension", "扩展");
  switch (kind) {
    case "composed":
    case "composed-theme":
      return tr("market.guideKindComposed", "组合件");
    case "pi-package":
      return tr("market.guideKindExtension", "扩展");
    default:
      return tr("market.guideKindPlugin", "插件");
  }
}
