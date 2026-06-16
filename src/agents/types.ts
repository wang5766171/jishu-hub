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
  install_package_manager: string | null;
  auto_installed: boolean;
  config_surface: ConfigSurface;
  project_settings_surface: ProjectSettingsSurface;
  terminal_surface: TerminalSurface;
  transport: TransportSurface;
  mcp_installed: boolean;
  mcp_version: string | null;
}

export type ConfigSurface =
  | { kind: "structured"; schema_id: string; supports_model_picker: boolean; supports_small_model: boolean; supports_large_model: boolean; supports_api_provider: boolean }
  | { kind: "raw"; format: string }
  | { kind: "model_store"; provider: string; supports_picker: boolean; supports_mcp: boolean }
  | { kind: "unsupported" };

export type ProjectSettingsSurface =
  | { kind: "supported"; scopes: ProjectSettingsScope[]; access_modes: string[] }
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

  CONFIG_GLOBAL: 1099511627776n,   // 1<<40
  CONFIG_PROJECT: 2199023255552n,  // 1<<41
  CONFIG_BACKUP: 4398046511104n,   // 1<<42
  CONFIG_TEMPLATES: 8796093022208n, // 1<<43

  SUBAGENT_DISPATCH: 1125899906842624n,  // 1<<50
  SUBAGENT_RECEIVE: 2251799813685248n,    // 1<<51

  RPC_BIDIRECTIONAL: 1152921504606846976n, // 1<<60
};
