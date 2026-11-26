/**
 * v0.9.8 评审修复轮 R2（用户裁决 4 / 契约 C3）：上下文压缩请求的唯一去向判断。
 *
 * 裁决：「压缩也变成一个排队消息，不立即执行了，压缩的执行也作为会话输出的
 * 执行，也就是压缩和普通消息等价处理」。
 *
 * 修前的问题：压缩请求不看引擎状态一律立即执行。回合进行中发起的压缩会先
 * 中止正在跑的回合，界面把「回合结束」当成「引擎空闲」，立刻把排队的消息
 * 发出去——正撞上还没结束的压缩，被引擎拒收。「回合结束」和「压缩开始」是
 * 两个状态源，压缩请求绕过了排队规则，它们之间就没有了先后保证。
 *
 * 现在压缩请求与普通消息走同一条规则：
 *  - 引擎空闲（该会话没有进行中的回合）→ 立即执行；
 *  - 回合进行中 → 进待发送区，成为一条普通排队消息（内容就是命令原文），
 *    轮到它且引擎空闲时才执行；压缩结束后继续按顺序投递后面的消息
 *    （见 event-pipeline 的 deliverNextStagedGuide 与压缩结束分支）。
 *  - 同一会话压缩进行中再次发起 → 维持提示。
 *
 * 两个入口（输入框发送 `/compact [要求]`、水位环里的「立即压缩」）都经
 * 页面的 handleCompactSession 走到这里——去向只有这一处判断。
 */
import { useCallback } from "react";
import type { MutableRefObject } from "react";
import type { TFunction } from "i18next";
import { streamStore } from "@/hooks/use-stream-store";
import { isNoSessionSelected } from "@/features/session-kernel/session-placeholder";
import type { StagedGuideApi } from "@/components/sessions/chat-input";
import { formatSlashCommand } from "@/lib/slash-command-parse";
import type { UseCompaction } from "./use-compaction";

export interface CompactionRequestDeps {
  /** 引擎空闲时的压缩执行（useCompaction.runCompact）。 */
  runCompact: UseCompaction["runCompact"];
  /** 某会话是否正在压缩（同步读）。 */
  isCompacting: (sessionId: string) => boolean;
  activeId: string | null;
  projectPathRef: MutableRefObject<string | null>;
  selectedSessionRef: MutableRefObject<string | null>;
  stagedApiRef: MutableRefObject<StagedGuideApi | null>;
  alertDialog: (opts: { title: string; description: string }) => unknown;
  t: TFunction;
}

export type RequestCompaction = (instructions?: string | null) => Promise<void>;

export function useCompactionRequest(deps: CompactionRequestDeps): RequestCompaction {
  const {
    runCompact,
    isCompacting,
    activeId,
    projectPathRef,
    selectedSessionRef,
    stagedApiRef,
    alertDialog,
    t,
  } = deps;

  return useCallback(
    async (instructions: string | null = null): Promise<void> => {
      const sessionId = selectedSessionRef.current;
      // 新对话 / 节点待定都不是会话（占位判定只在占位模块一处）
      if (!sessionId || isNoSessionSelected(sessionId)) return;
      if (isCompacting(sessionId)) {
        // 按钮在压缩进行中是禁用态；输入 /compact 发送没有这个禁用态，给出
        // 提示而不是静默忽略。
        void alertDialog({
          title: t("sessions.compactRunning"),
          description: t("sessions.compactAlreadyRunning"),
        });
        return;
      }
      if (streamStore.isStreaming(sessionId)) {
        // 回合进行中：与普通消息等价处理——进待发送区（排在用户在此期间
        // 暂存的消息之后），轮到它且引擎空闲时再执行。发送上下文入队即
        // 捕获（投递时跟会话走，与界面停留项目无关）。
        stagedApiRef.current?.stage(sessionId, {
          id: crypto.randomUUID(),
          content: formatSlashCommand("compact", instructions),
          context: { projectPath: projectPathRef.current ?? "", agentId: activeId ?? "" },
          kind: "compaction",
        });
        return;
      }
      await runCompact(sessionId, instructions, {
        agentId: activeId,
        projectPath: projectPathRef.current,
      });
    },
    [runCompact, isCompacting, activeId, projectPathRef, selectedSessionRef, stagedApiRef, alertDialog, t],
  );
}
