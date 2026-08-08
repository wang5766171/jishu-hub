/**
 * useDispatchRoleResolver —— 节点会话三角色解析器 hook（需求五 · 方案 A）。
 *
 * 设计依据：`docs/task-exec-dev/02-总体设计.md` §7.1。
 *
 * 职责：
 * 1. 调用 T0 的 `orchestrator_list_attempt_dispatches(nodeRunId)` 拿到该节点全部 attempt 的派发 prompt
 * 2. 归一化 + hash 成指纹集合
 * 3. 返回可直接传给 `<MessageView roleResolver={...} />` 的解析器
 *
 * 安全降级：
 * - nodeRunId 为空 / 命令不存在（orchestrator feature 关闭）/ 查询失败 / 无派发记录
 *   → 一律返回 undefined，MessageView 走原两角色路径，行为与改动前完全一致。
 * - 老库 dispatch_prompt 为 NULL 时后端已过滤，这里自然拿到空数组 → 同上降级。
 */
import { useEffect, useMemo, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import type { Message } from "@/types";
import type { MessageRoleView } from "@/components/sessions/message-view";
import type { AttemptDispatch } from "../types";
import { buildDispatchFingerprints, makeDispatchRoleResolver } from "./fingerprint";

export interface UseDispatchRoleResolverOptions {
  /** 节点运行 id（node_run_id）。为空时不查询。 */
  nodeRunId: string | null | undefined;
  /**
   * 最新 attempt 序号。变化时重新拉取派发记录
   * （节点重试会新增 attempt，指纹集需要跟着更新）。
   */
  attemptNumber?: number;
  /** 「任务助手」标签文案（i18n 由调用方给出）。 */
  label: string;
}

export interface DispatchRoleResolverState {
  /** 传给 MessageView 的解析器；无可用指纹时为 undefined（降级两角色）。 */
  roleResolver: ((msg: Message) => MessageRoleView | null) | undefined;
  /** 指纹条数（调试 / 命中率评估用）。 */
  fingerprintCount: number;
}

export function useDispatchRoleResolver({
  nodeRunId,
  attemptNumber,
  label,
}: UseDispatchRoleResolverOptions): DispatchRoleResolverState {
  const [prompts, setPrompts] = useState<string[]>([]);

  useEffect(() => {
    if (!nodeRunId) {
      setPrompts([]);
      return;
    }
    let cancelled = false;
    invokeCommand<AttemptDispatch[]>("orchestrator_list_attempt_dispatches", { nodeRunId })
      .then((list) => {
        if (cancelled) return;
        setPrompts((list ?? []).map((d) => d.prompt).filter((p): p is string => Boolean(p)));
      })
      .catch(() => {
        // orchestrator feature 关闭 / 老库 / 查询失败 —— 静默降级为两角色
        if (!cancelled) setPrompts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeRunId, attemptNumber]);

  return useMemo(() => {
    if (prompts.length === 0) {
      return { roleResolver: undefined, fingerprintCount: 0 };
    }
    const fingerprints = buildDispatchFingerprints(prompts);
    return {
      roleResolver: makeDispatchRoleResolver(fingerprints, label),
      fingerprintCount: fingerprints.size,
    };
  }, [prompts, label]);
}
