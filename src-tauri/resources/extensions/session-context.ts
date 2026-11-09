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

/**
 * v0.9.7 需求5 E5：默认工作空间（~/.jishu-hub/JishuProjects）会话的产物指引。
 * spawn 时新会话只有 pending id（env 无法预知真实 id），因此在这里每轮按
 * 真实 session_id 计算 `<默认空间>/sessions/<session_id>/`，同时写入
 * JISHU_SESSION_WORKSPACE（shell 等子进程继承）并注入 system prompt——
 * 指引级（cwd 仍是空间根，工具仍可写任意处），真实项目不注入。
 */
function sessionWorkspaceLine(sessionId: string): string | null {
  const hubHome = process.env.JISHU_HUB_HOME;
  const projectPath = process.env.JISHU_PROJECT_PATH;
  if (!hubHome || !projectPath) return null;
  const sep = process.platform === "win32" ? "\\" : "/";
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  const expected = `${norm(hubHome)}${sep}JishuProjects`;
  if (norm(projectPath).toLowerCase() !== expected.toLowerCase()) {
    return null;
  }
  const workspace = `${norm(projectPath)}${sep}sessions${sep}${sessionId}`;
  process.env.JISHU_SESSION_WORKSPACE = workspace;
  return `session_workspace: ${workspace}\n默认空间会话中，你生成的文件默认放在 session_workspace 指向的目录（即环境变量 JISHU_SESSION_WORKSPACE），各会话互不混放。\n引用链接注意：产物引用路径从项目根算起——本会话的文件引用需带 sessions/${sessionId}/ 前缀（如 jishu-artifact://sessions/${sessionId}/docs/结果.html）；一律正斜杠相对路径，禁止绝对路径与反斜杠（含空格用 %20）。`;
}

export default function sessionContextExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const workspaceLine = sessionWorkspaceLine(sessionId);
    const lines = [`session_id: ${sessionId}`];
    if (workspaceLine) lines.push(workspaceLine);
    const block =
      `<jishu-runtime-context>\n${lines.join("\n")}\n${GUIDANCE}\n</jishu-runtime-context>`;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });
}
