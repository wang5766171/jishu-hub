// v0.9.8 需求5（合并版）：装备安装执行器（共享 hook）。
// 从 plugin-market.tsx 抽离，两处消费：市场推荐区弹层 / 会话推荐卡。
// 五修继承（02 设计 D5-1）：
// ①取消令牌——cancel() 后剩余项不再发起（进行中单项任其完成）；
// ②重试保历史——retryFailed 按 ref merge，成功 ✓ 保留；
// ③失败原因可见——fail 行携带 error 文本；
// ④安全说明行——含技能项时的提示由消费方 UI 呈现（runner 提供 hasSkill）；
// ⑤类型名精确——kindNameOf 单源映射。
// 执行语义：串行、单项失败继续、已装跳过、安装结果如实落行——安装与结果判读
// 都经 installRef（R2-7：扩展撞名时行落「需确认」并弹确认卡，取消不算成功）。

import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { userFacingError } from "@/lib/user-facing-error";
import { installRef, useConflictAsker, type ConflictAsker } from "./install";
import type { InstallMeta } from "./api";

/** 行状态：pending 待装 / running 安装中 / confirm 撞名待确认 / ok 已装 /
 *  fail 失败（带原因）/ skipped 未安装（取消剩余项，或撞名确认时取消）。 */
export type RunState = "pending" | "running" | "confirm" | "ok" | "fail" | "skipped";

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
  /** 启动安装（refs 全量；执行时已装的件不装，行直接是已装）。 */
  run: (items: RunnerItem[]) => void;
  /** 取消剩余项（进行中单项任其完成；本次运行到它落定才结束）。 */
  cancel: () => void;
  /** 只重试失败项（成功历史 merge 保留）。 */
  retryFailed: () => void;
  /** 完成回调（全量落定：成功/失败汇总后触发一次）。 */
  setOnDone: (cb: (() => void) | null) => void;
  /** v0.9.8 评审修复轮 R1-7：结束本次运行——结果清空，回到未开始态。一次
   *  运行的结果只属于消费方的一次使用（如弹层的一次打开）；关闭时调用，
   *  下次打开是全新一轮。
   *  运行未落定时不要直接调：先 cancel()（剩余项不再发起），等在途项落定
   *（running 变回 false、onDone 触发）再调——直接调会丢掉在途项的结果，
   *  收尾回调也不触发。 */
  reset: () => void;
  /** 撞名确认卡（扩展工具与已装能力重叠时弹出）；消费方须渲染。 */
  conflictDialogNode: ReactNode;
}

export function useEquipmentRunner(): RunnerResult {
  const [statuses, setStatuses] = useState<RunStatus[]>([]);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  // 取消令牌：自增即作废旧运行（循环不再发起后续项；进行中单项的结果
  // 仍落回 statuses）。
  const runToken = useRef(0);
  // 运行代际：reset 时自增——此前启动的运行**不得再写入任何状态**（与
  // 取消令牌分开：取消保留进行中项的结果，重置丢弃旧运行的一切）。
  const generation = useRef(0);
  // 各 ref 的安装 meta，跨多轮累计（重试时按 ref 取回）。
  const metaByRefRef = useRef(new Map<string, InstallMeta | undefined>());
  const onDoneRef = useRef<(() => void) | null>(null);
  // 当前运行的写入口（cancel 经它改行状态——镜像与状态不会走岔）。
  const activeApplyRef = useRef<((fn: (rows: RunStatus[]) => RunStatus[]) => void) | null>(null);
  const { ask, dialogNode: conflictDialogNode } = useConflictAsker();
  const askRef = useRef<ConflictAsker>(ask);
  askRef.current = ask;

  const execute = useCallback(async (items: RunnerItem[], base: RunStatus[]) => {
    const token = ++runToken.current;
    const generationAtStart = generation.current;
    // base 是带进来的既有结果（上一轮的 ✓ / ✗ / 未安装），本轮的行从 pending 起。
    let current = base;
    // 本次运行的唯一写入口。已被 reset：这次运行的结果不再属于任何一次
    // 使用，丢弃。
    const apply = (fn: (rows: RunStatus[]) => RunStatus[]) => {
      if (generation.current !== generationAtStart) return;
      current = fn(current);
      setStatuses(current);
    };
    activeApplyRef.current = apply;
    runningRef.current = true;
    setRunning(true);
    apply(() => current);
    for (let i = 0; i < items.length; i++) {
      // 取消令牌校验（①：真取消——令牌作废后剩余项不再发起 IPC）。
      if (runToken.current !== token) break;
      const { ref, meta } = items[i];
      apply((rows) =>
        rows.map((r) => (r.ref === ref ? { ...r, state: "running" as const, error: undefined } : r)),
      );
      // 撞名待确认：行先落「需确认」，再弹确认卡（队列在此等用户决断）。
      const askWithState: ConflictAsker = async (display, conflicts) => {
        apply((rows) => rows.map((r) => (r.ref === ref ? { ...r, state: "confirm" as const } : r)));
        return askRef.current(display, conflicts);
      };
      try {
        const result = await installRef(ref, meta, askWithState);
        apply((rows) =>
          rows.map((r) =>
            r.ref === ref ? { ...r, state: result.kind === "declined" ? ("skipped" as const) : ("ok" as const) } : r,
          ),
        );
      } catch (e) {
        // ③：失败原因收集（UI 展开渲染）。二轮评审 R3（P2-15）：落行的是给用户
        // 看的文字——不带 Error: 前缀、机器前缀、括号里的英文原文。
        apply((rows) =>
          rows.map((r) => (r.ref === ref ? { ...r, state: "fail" as const, error: userFacingError(e) } : r)),
        );
      }
    }
    // 收尾只看运行代际：取消后进行中项落定，这里照常收尾（消费方据此刷新
    // 清单）；重置后不收尾——那一次使用已经结束。
    // 弹层开着关掉不影响这里：关的时候没有 reset（先 cancel、等落定再 reset），
    // 在途项的结果照样落、onDone 照样触发。
    if (generation.current === generationAtStart) {
      runningRef.current = false;
      setRunning(false);
      onDoneRef.current?.();
    }
    if (activeApplyRef.current === apply) activeApplyRef.current = null;
  }, []);

  const run = useCallback(
    (items: RunnerItem[]) => {
      // 串行：一次运行落定前不发起新的（落定 = 队列走完，或取消后在途项落定）。
      // 两轮并行会互相覆盖结果，也会对同一件重复安装。
      if (runningRef.current) return;
      for (const i of items) metaByRefRef.current.set(i.ref, i.meta);
      // 与上一轮的结果合并：同一批里先前装成的 ✓、失败的 ✗ 都保留，本轮的行
      // 从 pending 重新开始——「取消剩余项」之后再点安装属于这种情况。
      const fresh = new Set(items.map((i) => i.ref));
      const base: RunStatus[] = [
        ...statuses.filter((s) => !fresh.has(s.ref)),
        ...items.map((i) => ({ ref: i.ref, state: "pending" as const })),
      ];
      void execute(items, base);
    },
    [execute, statuses],
  );

  const cancel = useCallback(() => {
    // 取消令牌作废：循环下一轮 break，剩余项不再发起。
    runToken.current += 1;
    // 没轮到的行记「未安装」——没失败，只是没装。进行中那一项任其完成：本次
    // 运行到它落定才结束（落定前 running 仍是 true：发不起下一轮；消费方此刻
    // 若要收起界面——如关掉套装弹层——不能 reset，等落定再 reset）。
    activeApplyRef.current?.((rows) =>
      rows.map((r) => (r.state === "pending" ? { ...r, state: "skipped" as const } : r)),
    );
  }, []);

  const retryFailed = useCallback(() => {
    if (runningRef.current) return;
    const failed = statuses.filter((s) => s.state === "fail").map((s) => s.ref);
    if (failed.length === 0) return;
    const items = failed.map((ref) => ({ ref, meta: metaByRefRef.current.get(ref) }));
    // ②：merge——已落定的行保留（✓ 与未安装都算历史），失败行重置 pending。
    const base: RunStatus[] = [
      ...statuses.filter((s) => s.state !== "fail"),
      ...failed.map((ref) => ({ ref, state: "pending" as const })),
    ];
    void execute(items, base);
  }, [execute, statuses]);

  const setOnDone = useCallback((cb: (() => void) | null) => {
    onDoneRef.current = cb;
  }, []);

  const reset = useCallback(() => {
    generation.current += 1;
    runToken.current += 1;
    runningRef.current = false;
    activeApplyRef.current = null;
    metaByRefRef.current.clear();
    setRunning(false);
    setStatuses([]);
  }, []);

  const hasSkill = statuses.some((s) => s.ref.startsWith("skillhub:"));

  return { statuses, running, hasSkill, run, cancel, retryFailed, setOnDone, reset, conflictDialogNode };
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
