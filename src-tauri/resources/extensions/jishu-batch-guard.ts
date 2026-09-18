/**
 * jishu-batch-guard（v0.9.3 需求22 P2：自 pi harness 内置守卫迁主仓部署扩展
 * ——零 fork；pi 侧 batch-guard.ts 及 drive/tools.ts 接线已撤）。
 *
 * 防并行工具调用爆炸（2026-09-09 线上实录：单条消息 636 个 toolCall 全部
 * 执行）：agent 级 tool_call 钩子（执行前逐调用触发、含并行路径）按轮计数，
 * 超上限立即 block 并指引下一轮继续——任务不中断，跨轮不受限。
 * 上限 50：高于主流最低值两倍、远低于爆炸量级，防爆炸阈值而非效率配额
 * （设计裁决沿用原 fork，见 PI_CHANGE 2026-09-09）。
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const MAX_TOOL_CALLS_PER_TURN = 50;

const batchGuard: ExtensionFactory = (pi) => {
  let executed = 0;
  // 每轮（用户消息 → 回合结束）重置：before_agent_start 在每轮 agent 启动前
  // 触发，跨轮不受限的语义由此保证。
  pi.on("before_agent_start", () => {
    executed = 0;
  });
  pi.on("tool_call", () => {
    executed += 1;
    if (executed <= MAX_TOOL_CALLS_PER_TURN) {
      return undefined;
    }
    return {
      block: true,
      reason:
        `[jishu-batch-guard] 本轮工具调用已达上限 ${MAX_TOOL_CALLS_PER_TURN}（防并行调用爆炸）。`
        + "请把剩余操作拆分为多轮，下一轮继续执行。",
    };
  });
};

export default batchGuard;
