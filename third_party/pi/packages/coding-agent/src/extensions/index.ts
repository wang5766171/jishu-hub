import type { InlineExtension } from "../core/extensions/types.ts";
import jishuToolApproval from "./jishu-approval/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	// jishu v0.84.2-11（hub v0.8.0 需求1 P-2）：逐次工具审批（模式经
	// settings.toolApproval 控制，off 时零开销直接放行）。
	jishuToolApproval,
];
