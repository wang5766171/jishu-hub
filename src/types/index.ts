export interface Project {
  name: string;
  path: string;
  encoded_name: string;
  session_count: number;
  last_active: string | null;
  has_claude_md: boolean;
  agent_ids?: string[];
  initialized: boolean;
}

export interface ProjectMeta {
  custom_name?: string;
  tags?: string[];
  notes?: string;
}

export interface Message {
  role: string;
  content: ContentBlock[];
  timestamp: number | null;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown }
  | { type: "thinking"; thinking: string };

export interface Session {
  id: string;
  path: string;
  messages: Message[];
  started_at: string | null;
  display_name?: string;
  last_active: string | null;
  project_path?: string;
}

export interface SessionSearchResult {
  sessionId: string;
  matchCount: number;
  previewText: string;
  firstMatchIndex: number;
}

export interface HistoryEntry {
  display: string;
  timestamp: number | null;
  project: string | null;
  sessionId: string | null;
}

export interface PermissionsConfig {
  allow: string[] | null;
  deny: string[] | null;
  defaultMode: string | null;
  additionalDirectories: string[] | null;
}

export interface McpServerConfig {
  command: string | null;
  args: string[] | null;
  env: Record<string, unknown> | null;
  cwd: string | null;
  type: string | null;
  url: string | null;
}

export interface HookAction {
  type: string;
  command: string | null;
  timeout: number | null;
}

export interface HookMatcher {
  matcher: string | null;
  hooks: HookAction[];
}

export interface SandboxConfig {
  enabled: boolean | null;
  allowCommand: string[] | null;
  denyCommand: string[] | null;
  allowPath: string[] | null;
  denyPath: string[] | null;
  network: string | null;
  profile: string | null;
}

export interface ContextCompactionConfig {
  threshold: number | null;
  method: string | null;
}

export interface ClaudeConfig {
  model: string | null;
  env: Record<string, string> | null;
  enabledPlugins: Record<string, boolean> | null;
  skipDangerousModePermissionPrompt: boolean | null;
  permissions: PermissionsConfig | null;
  mcpServers: Record<string, McpServerConfig> | null;
  apiProvider: string | null;
  smallModel: string | null;
  largeModel: string | null;
  allowedTools: string[] | null;
  disallowedTools: string[] | null;
  hooks: Record<string, HookMatcher[]> | null;
  sandbox: SandboxConfig | null;
  verbose: boolean | null;
  maxTurns: number | null;
  contextCompaction: ContextCompactionConfig | null;
}

export interface ConfigTemplate {
  id: string;
  name: string;
  description: string;
  config: ClaudeConfig;
}

export interface Preset {
  id: string;
  name: string;
  description?: string;
  config: ClaudeConfig;
  createdAt: string;
}

export interface BackupEntry {
  name: string;
  path: string;
  timestamp: string | null;
}

export type Page = "chat" | "manage";

export type ManageTab = "projects" | "config" | "commands" | "env";

export interface AgentInfo {
  id: string;
  display_name: string;
  version: string;
  icon: string;
  enabled: boolean;
}

export interface CustomCommand {
  id: string;
  name: string;
  command: string;
  agentId?: string | null;
  projectPath: string | null;
}

export interface AgentCommandPreset {
  name: string;
  command: string;
}

export interface ProjectPermissions {
  defaultMode: string | null;
  allow: string[] | null;
  deny: string[] | null;
}

export interface HookCommand {
  type: string;
  command: string;
}

export interface HookEntry {
  matcher: string | null;
  hooks: HookCommand[];
}

export interface ProjectSettings {
  permissions: ProjectPermissions | null;
  hooks: Record<string, HookEntry[]> | null;
  env: Record<string, string> | null;
  model: string | null;
}

export interface ProjectMergeInfo {
  [primary: string]: string[];
}

export interface ChatSession {
  agent_id: string;
  session_id: string;
  process_id: number;
}

export interface StreamChunk {
  session_id: string;
  event_type: string;
  data: NormalizedEvent;
}

export interface AgentStreamChunk extends StreamChunk {
  agent_id: string;
}

export type NormalizedEvent =
  | { kind: "text_delta"; delta: string }
  | { kind: "message"; content: ContentBlock[] }
  | { kind: "tool_use_start"; call_id: string; tool: string; input: unknown }
  | { kind: "tool_use_result"; call_id: string; output: unknown; is_error: boolean }
  | { kind: "thinking"; delta: string }
  | { kind: "approval_request"; request_id: string; approval_kind: string; payload: unknown }
  | { kind: "session_resolved"; session_id: string }
  | { kind: "turn_complete"; reason: string; usage: unknown | null }
  | { kind: "error"; message: string; recoverable: boolean }
  | { kind: "task_step"; run_id: string; step_id: string; step_kind: string; title: string; detail?: unknown }
  | { kind: "sub_agent_dispatch"; run_id: string; step_id: string; target_agent: string; sub_run_id?: string; request: unknown }
  | { kind: "sub_agent_event"; run_id: string; step_id: string; sub_event: NormalizedEvent }
  | { kind: "raw"; agent: string; raw: unknown };

export interface InputFile {
  data: string;
  filename: string;
  label: string | null;
}

export interface SavedFile {
  path: string;
  label: string;
  index: number;
  batch_id: string;
}

export interface ModelPreset {
  id: string;
  display_name: string;
  protocol: string;
  base_url: string;
  model: string;
  api_key_env: string;
  max_tokens: number;
  temperature: number;
  supports_tools: boolean;
  supports_thinking: boolean;
}

export interface ModelStore {
  presets: ModelPreset[];
  active: string | null;
}
