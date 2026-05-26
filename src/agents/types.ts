export interface AgentInfo {
  id: string;
  display_name: string;
  version: string;
  icon: string;
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
  capabilities: number;
  health: AgentHealth;
  install_hint: string | null;
}

export class CapabilitySet {
  constructor(private flags: number) {}

  has(name: string): boolean {
    const flag = CapabilityFlags[name];
    if (flag === undefined) return false;
    return (this.flags & flag) === flag;
  }

  get raw(): number {
    return this.flags;
  }
}

// Pre-computed decimal values to avoid JS 32-bit shift overflow
export const CapabilityFlags: Record<string, number> = {
  RESUME_BY_ID: 1,
  RESUME_LATEST: 2,
  RESUME_PICKER: 4,
  SESSION_FORK: 8,
  SESSION_LIST: 16,
  SESSION_DELETE: 32,
  SESSION_EXPORT: 64,
  SESSION_IMPORT: 128,

  IMAGE_INPUT: 1024,
  FILE_INPUT: 2048,
  STDIN_PROMPT: 4096,

  STREAM_TEXT_DELTA: 1048576,
  STREAM_TOOL_CALLS: 2097152,
  STREAM_THINKING: 4194304,
  PARTIAL_MESSAGE: 8388608,

  ABORT: 1073741824,
  APPROVAL_REQUEST: 2147483648,

  CONFIG_GLOBAL: 1099511627776,   // 1<<40
  CONFIG_PROJECT: 2199023255552,  // 1<<41
  CONFIG_BACKUP: 4398046511104,   // 1<<42
  CONFIG_TEMPLATES: 8796093022208, // 1<<43

  SUBAGENT_DISPATCH: 1125899906842624,  // 1<<50
  SUBAGENT_RECEIVE: 2251799813685248,    // 1<<51

  RPC_BIDIRECTIONAL: 1152921504606846976, // 1<<60
};
