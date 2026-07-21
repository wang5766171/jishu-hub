/**
 * session-context — 把当前会话的 session_id 注入到 system prompt（每轮）。
 *
 * 背景：conductor 需要读到当前 Pi session_id，才能把需求/规划会话写回 TaskInstance。
 * 原来 Hub
 * 把 `<jishu-runtime-context>session_id: <id>` 拼进每条 user message，pi 原样持久化
 * 进 JSONL，导致会话列表名/内容/搜索被这段提示词污染。
 *
 * 改为本扩展在 `before_agent_start` 把 session_id 追加进 system prompt：
 * - system prompt 不写 user message 持久化（pi_session.rs 不读 system prompt），污染根除；
 * - LLM 仍每轮可读 session_id（system prompt 进 LLM 上下文）；
 * - session_id 取 pi 真实 id（ctx.sessionManager.getSessionId()），与 TaskInstance
 *   requirement_session_id / planning_session_id 一致。
 *
 * 注入用 `before_agent_start` 返回 `{systemPrompt}`（链式：event.systemPrompt = base
 * 或前扩展结果，追加后返回，不冲掉 pi 默认指令）。conductor 扩展不改 system prompt，
 * 零冲突。import 用 type-only 规避 pi loader 在 Full pi-bundle 下解析
 * @earendil-works/pi-coding-agent 失败的 bug（同 request-user-input 的处理）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUIDANCE =
  "该 session_id 由系统在每轮注入；conductor 需要当前会话时直接使用这个值，不要扫描 sessions 目录、猜测最新文件或自行推断。";

export default function sessionContextExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const block =
      `<jishu-runtime-context>\nsession_id: ${sessionId}\n${GUIDANCE}\n</jishu-runtime-context>`;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });
}
