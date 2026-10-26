export interface AgentInfo {
  id: string;
  display_name: string;
  version: string;
  icon: string;
  logo_path: string | null;
  enabled: boolean;
}

export interface AgentHealth {
  installed: boolean;
  version: string | null;
  error: string | null;
  binary_path: string | null;
  last_checked_at: number;
}

export interface AgentStatus {
  id: string;
  display_name: string;
  icon: string;
  logo_path: string | null;
  capabilities: string;
  health: AgentHealth;
  install_hint: string | null;
  native_install_command: string | null;
  available_version: string | null;
  install_package_manager: string | null;
  auto_installed: boolean;
  config_surface: ConfigSurface;
  project_settings_surface: ProjectSettingsSurface;
  terminal_surface: TerminalSurface;
  transport: TransportSurface;
  /** 配置目录存在（v0.9.0 需求21：CLI 未装但桌面端配置目录在——可进入设置页）。 */
  config_dir_exists?: boolean;
  mcp_installed: boolean;
  mcp_version: string | null;
  /** Transport-bridge dependency status (only meaningful when supported). */
  transport_bridge: TransportBridgeStatus;
  /** 可切换的权限模式（空/缺省 = 不支持；v0.7.3 需求2 P-3）。 */
  permission_modes?: string[];
  /** 可选 thinking 档位（空/缺省 = 不支持，隐藏选择器；v0.7.4 需求1 A7）。 */
  thinking_levels?: string[];
  /** Hub 侧持久化的当前档位（会话内生效值以 thinking_level_changed 事件为准）。 */
  thinking_level?: string | null;
  /** 权限模式读写提供方。 */
  permission_mode_provider?: "project_settings" | "hub_tool_mode" | "agent_config";
  /** 内建 agent（随 hub 分发/升级；环境检测置顶、任务模式引擎；v0.7.4 需求3 M1）。 */
  builtin?: boolean;
}

/**
 * Transport-bridge dependency status. claude_code's effective transport
 * (AcpPreferred) depends on the external `claude-agent-acp` binary; when it is
 * absent the agent falls back to Cli. Surfaced in the env-check page the same
 * way the MCP adapter status is.
 */
export interface TransportBridgeStatus {
  /** Whether this agent declares a transport-bridge dependency at all. */
  supported: boolean;
  /** Whether the bridge binary is resolvable on PATH. */
  installed: boolean;
  version: string | null;
  /** Human-facing bridge binary label (e.g. `claude-agent-acp`). */
  name: string | null;
}

export type ConfigSurface =
  | {
      kind: "structured";
      schema_id: string;
      supports_model_picker: boolean;
      supports_small_model: boolean;
      supports_large_model: boolean;
      supports_api_provider: boolean;
      /** 快速配置（代理服务商引导）入口显隐（v0.7.4 需求2 R2a）。 */
      supports_proxy_setup?: boolean;
      /** 「测试连接」按钮显隐（v0.7.4 需求2 R2c）。 */
      supports_config_test?: boolean;
      /** 「推理力度」配置入口显隐（v0.7.4 需求4 B1：codex 声明；新会话生效）。 */
      supports_reasoning_effort?: boolean;
      /** 思考预算快捷入口（env.MAX_THINKING_TOKENS）显隐（需求4 B1：claude 声明）。 */
      supports_thinking_budget?: boolean;
      /** 模型推荐目录标识（"claude" / "opencode"；缺省 = 仅自由输入）。 */
      model_catalog?: string | null;
      /** 自定义模型供应商管理入口显隐（R12：opencode 声明）。 */
      supports_custom_providers?: boolean;
      /** model_providers 渠道管理入口显隐（v0.7.5 需求7：codex 声明——
       * config.toml 的直连/中转切换，与 opencode provider 段机制不同）。 */
      supports_model_providers?: boolean;
    }
  | { kind: "raw"; format: string }
  | { kind: "model_store"; provider: string; supports_picker: boolean; supports_mcp: boolean }
  | { kind: "unsupported" };

export type ProjectSettingsSurface =
  | {
      kind: "supported";
      scopes: ProjectSettingsScope[];
      access_modes: string[];
      /** 该 agent 项目配置支持的字段（permissions/env/model/hooks/thinking_level 子集）。 */
      fields?: string[];
    }
  | { kind: "unsupported"; reason: string | null };

export type ProjectSettingsScope = "shared" | "local";

export type TerminalSurface =
  | { kind: "supported" }
  | { kind: "unsupported"; reason: string | null };

export type TransportSurface =
  | "acp_preferred"
  | "pi_rpc"
  | "cli"
  | "embedded"
  | "codex_app_server";

export class CapabilitySet {
  private flags: bigint;

  constructor(flags: string | number | bigint) {
    this.flags = BigInt(flags);
  }

  has(name: string): boolean {
    const flag = CapabilityFlags[name];
    if (flag === undefined) return false;
    return (this.flags & flag) === flag;
  }

  get raw(): bigint {
    return this.flags;
  }
}

// Pre-computed decimal values to avoid JS 32-bit shift overflow
export const CapabilityFlags: Record<string, bigint> = {
  RESUME_BY_ID: 1n,
  RESUME_LATEST: 2n,
  RESUME_PICKER: 4n,
  SESSION_FORK: 8n,
  SESSION_LIST: 16n,
  SESSION_DELETE: 32n,
  SESSION_EXPORT: 64n,
  SESSION_IMPORT: 128n,

  IMAGE_INPUT: 1024n,
  FILE_INPUT: 2048n,
  STDIN_PROMPT: 4096n,

  STREAM_TEXT_DELTA: 1048576n,
  STREAM_TOOL_CALLS: 2097152n,
  STREAM_THINKING: 4194304n,
  PARTIAL_MESSAGE: 8388608n,

  ABORT: 1073741824n,
  APPROVAL_REQUEST: 2147483648n,

  PRE_EXECUTION_INTERCEPTION: 4294967296n, // 1<<32
  CONTEXT_COMPACT: 8589934592n,            // 1<<33（v0.7.4 需求1 A3）
  TASK_MODE: 17179869184n,                 // 1<<34（v0.7.4 需求3 M2 任务工作模式）

  CONFIG_GLOBAL: 1099511627776n,   // 1<<40
  CONFIG_PROJECT: 2199023255552n,  // 1<<41
  CONFIG_BACKUP: 4398046511104n,   // 1<<42
  CONFIG_TEMPLATES: 8796093022208n, // 1<<43

  SUBAGENT_DISPATCH: 1125899906842624n,  // 1<<50
  SUBAGENT_RECEIVE: 2251799813685248n,    // 1<<51

  RPC_BIDIRECTIONAL: 1152921504606846976n, // 1<<60
};
