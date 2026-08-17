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

export interface ConversationInteractionOption {
  optionId: string;
  label: string;
  description?: string | null;
}

/** Transport that surfaced an interaction (mirrors Rust `InteractionTransport`). */
export type InteractionTransport =
  | "unspecified"
  | "pi_rpc"
  | "acp_preferred"
  | "codex_app_server"
  | "cli"
  | "embedded";

/** Protocol channel / origin of an interaction (mirrors Rust `InteractionOrigin`).
 *  Determines whether the answer can be written back mid-turn. */
export type InteractionOrigin =
  | "text"
  | "extension_ui"
  | "acp_elicitation"
  | "codex_tool_request_user_input"
  | "codex_mcp_approval"
  | "codex_approval";

/** Forward-looking write-back hint embedded in an interaction event. Advisory
 *  only — the authoritative decision is `InteractionResponseDto.delivery`. */
export type InteractionDeliveryHint = "follow_up" | "mid_turn";

/** Authoritative delivery outcome returned by `respond_chat_interaction`.
 *  - `mid_turn`: answer was injected into the running turn (interleave it).
 *  - `follow_up`: answer became a new user message (render normally). */
export type InteractionDelivery = "mid_turn" | "follow_up";

/** DTO returned by the `respond_chat_interaction` Tauri command. */
export interface InteractionResponseDto {
  delivery: InteractionDelivery;
}

/** Native correlation scope carried with an interaction so the backend can
 *  locate the exact pending server request to write back. Opaque to the
 *  frontend — preserved verbatim from the event and echoed back on submit. */
export interface InteractionCorrelation {
  agent_id?: string | null;
  session_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  server_request_id?: string | null;
  jsonrpc_id?: unknown | null;
  request_kind?: string | null;
}

export interface ConversationInteractionRequest {
  requestId: string;
  prompt: string;
  options: ConversationInteractionOption[];
  allowMultiple: boolean;
  allowCustomText: boolean;
  required: boolean;
  transport?: InteractionTransport;
  origin?: InteractionOrigin;
  deliveryHint?: InteractionDeliveryHint;
  correlation?: InteractionCorrelation | null;
}

export interface ConversationInteractionSubmission {
  requestId: string;
  selectedOptionIds: string[];
  customText: string;
}

export type ContentBlock =
  | { type: "text"; text: string; frozen?: boolean }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown }
  | { type: "thinking"; thinking: string; frozen?: boolean }
  | {
      type: "interaction";
      request_id?: string;
      prompt: string;
      options?: Array<{ option_id: string; label: string; description?: string | null }>;
      answer: string;
      selected_options?: string[];
      origin?: string;
    }
  | { type: "phase_divider"; phase: string; title: string };

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
  /** HTTP headers for url-based MCP servers. Supports ${ENV_VAR} interpolation. */
  headers: Record<string, string> | null;
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
  /** 推理力度（v0.7.4 需求4 B1：codex 专用，其余 agent 为 null）。 */
  reasoningEffort: string | null;
  /** 自定义模型供应商（v0.7.4 R12：opencode 的 provider 段；其余 agent 为 null）。 */
  customProviders: Record<string, Record<string, unknown>> | null;
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
  config: unknown;
  /** 应用前需补填（adapter 在 config_templates() 中声明，后端 serde 默认 false） */
  requires_fill?: boolean;
}

export interface Preset {
  id: string;
  name: string;
  description?: string;
  config: unknown;
  createdAt: string;
}

export interface BackupEntry {
  name: string;
  path: string;
  timestamp: string | null;
}

export type Page = "chat" | "manage";

/** 智能体设置子页（v0.7.4 需求2 R4/R5：侧边栏「智能体设置」分组下的独立页面）。 */
export type AgentConfigSection =
  | "models"
  | "behavior"
  | "templates"
  | "backups"
  | "advanced";

export type ManageTab =
  | "projects"
  | "agent-models"
  | "agent-behavior"
  | "agent-templates"
  | "agent-backups"
  | "agent-advanced"
  | "commands"
  | "env";

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
  /** 默认思考档位（jishu 项目配置 defaultThinkingLevel；其余 agent 忽略）。 */
  thinkingLevel?: string | null;
  /** 上下文压缩（jishu 项目配置 compaction；其余 agent 忽略）。 */
  compaction?: {
    enabled?: boolean | null;
    reserveTokens?: number | null;
    keepRecentTokens?: number | null;
  } | null;
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

/**
 * The `agent-event` Tauri payload is emitted as either a single chunk or an
 * array of chunks. Extracted as a named type because Babel's TS parser mishandles
 * the `AgentStreamChunk[]` array shorthand inside a `listen<...>()` type-argument
 * list (it breaks the Vite dev build); a named identifier parses cleanly.
 */
export type AgentEventPayload = AgentStreamChunk[] | AgentStreamChunk;

export type NormalizedEvent =
  | { kind: "text_delta"; delta: string }
  | { kind: "message"; content: ContentBlock[] }
  | { kind: "tool_use_start"; call_id: string; tool: string; input: unknown }
  | { kind: "tool_use_result"; call_id: string; output: unknown; is_error: boolean }
  | { kind: "thinking"; delta: string }
  | { kind: "approval_request"; request_id: string; approval_kind: string; payload: unknown }
  | {
      kind: "interaction_request";
      request_id: string;
      prompt: string;
      options: Array<{
        option_id: string;
        label: string;
        description?: string | null;
      }>;
      allow_multiple: boolean;
      allow_custom_text: boolean;
      required: boolean;
      /** Transport that surfaced the interaction. Advisory; may be absent on
       *  legacy/persisted events. See `InteractionTransport`. */
      transport?: InteractionTransport;
      /** Protocol channel / origin (business question vs. approval vs. elicitation).
       *  Absent → treated as the generic text channel. */
      origin?: InteractionOrigin;
      /** Forward-looking write-back hint — advisory only. The authoritative
       *  decision is the `delivery` returned by `respond_chat_interaction`. */
      delivery_hint?: InteractionDeliveryHint;
      /** Native correlation scope the backend uses to locate the pending server
       *  request to write back. Opaque to the frontend; passed through as-is. */
      correlation?: InteractionCorrelation | null;
    }
  | { kind: "session_resolved"; session_id: string }
  | { kind: "thinking_level_changed"; level: string }
  | { kind: "steer_injected"; content: string }
  | { kind: "turn_complete"; reason: string; usage: unknown | null }
  | { kind: "error"; message: string; recoverable: boolean }
  | { kind: "task_step"; run_id: string; step_id: string; step_kind: string; title: string; detail?: unknown }
  | { kind: "sub_agent_dispatch"; run_id: string; step_id: string; target_agent: string; sub_run_id?: string; request: unknown }
  | { kind: "sub_agent_event"; run_id: string; step_id: string; sub_event: NormalizedEvent }
  | { kind: "raw"; agent: string; raw: unknown }
  | { kind: "phase_divider"; phase: string; title: string };

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
