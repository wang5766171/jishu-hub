/**
 * jishu-batch-guard（v0.9.3 需求22 P2：自 pi harness 内置守卫迁主仓部署扩展
 * ——零 fork；v0.9.4 需求5 语义重写：重复检测制）。
 *
 * 防工具调用循环爆炸（2026-09-09 线上实录：同一工具被重复调用 636 次全部
 * 执行）。v0.9.3 版按「每轮任意调用总数 ≥50」计数，误伤正常重活（读文件/
 * grep/编辑交错的单轮 50-100+ 次）——事故形态是「重复」而非「总量」，本版
 * 对准真实形态改为三层重复检测（用户裁决 2026-09-21）：
 *
 * 1. 同签名（同工具+同参数）连续 ≥4 次 → block：同调用死循环（636 事故
 *    直接形态；阈值容 1-2 次合法重试如 flaky 测试重跑）。
 * 2. 同工具（参数可不同）连续 ≥40 次 → block：参数微变的同工具刷屏循环
 *    （大批量逐文件编辑等合法场景留足余量）。
 * 3. 每轮绝对总数 ≥500 → block：非连续形态兜底（A/B 交替循环等；正常
 *    重活 10 倍余量、远低于事故量级）。
 *
 * 出现不同签名/工具即重置对应连击计数；每轮（before_agent_start）清零。
 * 超限立即 block 并指引排查——任务不中断，跨轮不受限。
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** 同签名（同工具+同参数）连续重复上限。 */
const MAX_IDENTICAL_STREAK = 4;
/** 同工具（参数可不同）连续调用上限。 */
const MAX_SAME_TOOL_STREAK = 40;
/** 每轮绝对总数兜底上限。 */
const MAX_TOOL_CALLS_PER_TURN = 500;

const batchGuard: ExtensionFactory = (pi) => {
	let executed = 0;
	let lastSignature = "";
	let identicalStreak = 0;
	let lastTool = "";
	let toolStreak = 0;
	// 每轮（用户消息 → 回合结束）重置：before_agent_start 在每轮 agent 启动前
	// 触发，跨轮不受限的语义由此保证。
	pi.on("before_agent_start", () => {
		executed = 0;
		lastSignature = "";
		identicalStreak = 0;
		lastTool = "";
		toolStreak = 0;
	});
	pi.on("tool_call", (event) => {
		executed += 1;
		// 签名 = 工具名 + 参数序列化（模型重复发出同一调用时 JSON 键序稳定，
		// 可靠区分「真重复」与「同工具不同目标」）。
		const tool = event.toolName;
		const signature = `${tool}::${JSON.stringify(event.input)}`;

		identicalStreak = signature === lastSignature ? identicalStreak + 1 : 1;
		toolStreak = tool === lastTool ? toolStreak + 1 : 1;
		lastSignature = signature;
		lastTool = tool;

		if (identicalStreak >= MAX_IDENTICAL_STREAK) {
			return {
				block: true,
				reason:
					`[jishu-batch-guard] 检测到同一调用连续重复 ${identicalStreak} 次（${tool}，参数相同）`
					+ "——疑似循环。请检查结果反馈是否可读、换思路或改参数后重试；下一轮继续不受限。",
			};
		}
		if (toolStreak >= MAX_SAME_TOOL_STREAK) {
			return {
				block: true,
				reason:
					`[jishu-batch-guard] 工具 ${tool} 已连续调用 ${toolStreak} 次（参数各异）`
					+ "——疑似同工具刷屏循环。请确认任务是否可推进或换工具/拆分批次；下一轮继续不受限。",
			};
		}
		if (executed >= MAX_TOOL_CALLS_PER_TURN) {
			return {
				block: true,
				reason:
					`[jishu-batch-guard] 本轮工具调用已达绝对上限 ${MAX_TOOL_CALLS_PER_TURN}（爆炸兜底）。`
					+ "请把剩余操作拆分为多轮，下一轮继续执行。",
			};
		}
		return undefined;
	});
};

export default batchGuard;
