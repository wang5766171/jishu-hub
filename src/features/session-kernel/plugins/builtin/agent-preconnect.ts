import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor } from "../types";

/**
 * Agent 预连接池（v0.9.7 需求12）——**无挂载的引擎级会话插件**。
 *
 * 实现全在 Rust（`src-tauri/src/preconnect.rs`）：对当前焦点标签项目预
 * spawn jishu agent RPC 进程存池（冷启动——Node 加载/扩展装载/MCP 连接
 * ——在池中提前完成），新会话首连直接接管现成进程。本描述符仅承担
 * 管理面：开关 = 池总闸（禁用即杀池），配置面 maxPool = 池深
 * （「用掉的预连接数不算」：空闲条目恒补齐）。
 *
 * 前端触发链：app.tsx 于启动/标签切换时 invoke `plugin_preconnect_focus`
 * 声明焦点项目；接管/补池在 Rust 会话启动链内闭环。
 */
export const agentPreconnectPlugin: SessionPluginDescriptor = {
  id: "session.agent-preconnect",
  displayNameKey: "sessionPlugins.agentPreconnect.name",
  displayNameFallback: "智能体预连接",
  descriptionKey: "sessionPlugins.agentPreconnect.description",
  descriptionFallback:
    "对当前标签项目预启动智能体进程，新对话首连免冷启动等待（跟随标签切换，仅对新会话生效）",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: [],
  // 引擎级插件无会话挂载点——mounts 为空（实现于 Rust 预连接池）。
  mounts: [],
  configSchema: [
    {
      key: "maxPool",
      type: "number",
      label: "最大预连接数",
      description: "同时保持的空闲预连接进程数（用掉即补；范围 1-8）",
      default: 3,
      min: 1,
      max: 8,
      step: 1,
      unit: "个",
    },
  ],
};
