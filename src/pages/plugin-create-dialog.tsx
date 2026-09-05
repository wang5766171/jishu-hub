import { useEffect, useMemo, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "react-i18next";
import { Bot, Code2, FileJson, Loader2, Plus, Sparkles, Terminal, X, Blocks } from "lucide-react";
import { cn } from "@/lib/utils";

/** v0.8.1 需求6：插件创建可视化界面——模版快速创建（claude/codex/opencode
 * 形态预填）+ 分组表单 + 字段级能力说明。提交走 plugin_create（后端全量
 * schema 校验 + serde 生成 TOML，前端零拼 TOML）。
 * v0.9.0 需求1 二期：MCP 区表单/JSON 双模式 + stdio/HTTP/SSE 三传输 +
 * 解析器（mcp-resolver）开关联动（参考 Claude Desktop 界面）。
 * v0.9.0 需求19：类型优先重构——pluginType（MCP/CLI/AGENT，用户心智三分
 * + 两种实现形式）为纯前端概念，映射 wire kind（mcp/cli→tool，agent→agent）；
 * 选中类型后下方只渲染该类型分组（渐进式披露）。 */

interface CreateProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  /** 编辑模式（v0.8.1 GUI 反馈：新增插件无法编辑）：传入插件 id 时对话框
   * 预填其 manifest，id 锁定，提交走 plugin_update 覆盖写回。 */
  editPluginId?: string | null;
  /** MCP 解析器（mcp-resolver 系统插件）启用态（v0.9.0 需求1 二期）：
   * 关闭时 MCP 区不可添加（提示先启用）；编辑既有 MCP 插件不受限。 */
  mcpResolverEnabled?: boolean;
  /** Skill 解析器（skill-resolver 系统插件）启用态（v0.9.0 需求20）：
   * 关闭时 SKILL 区不可添加（提示先启用）；编辑既有 skill 插件不受限。 */
  skillResolverEnabled?: boolean;
}

/** 插件类型（v0.9.0 需求19/20，用户心智分类）：
 * mcp/skill/cli/custom → wire kind="tool"（差异在 [mcp]/[skill]/[tool] 段及
 * 组合自由度——custom = 任意段自由组合）；agent → kind="agent"。 */
export type PluginType = "mcp" | "skill" | "cli" | "custom" | "agent";

/** MCP 传输类型（与后端 McpSection.type 对齐）。 */
type McpTransport = "stdio" | "http" | "sse";

/** 参考图 JSON 模式的归一化 server 条目（parseMcpServerJson 产物）。 */
export interface McpServerEntry {
  type: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** 表单模型（提交时转换为 manifest JSON wire 结构；导出供测试构造）。 */
export interface FormState {
  id: string;
  displayName: string;
  icon: string;
  installHint: string;
  probeEnabled: boolean;
  probeCommand: string;
  versionArgs: string;
  versionRegex: string;
  transportKind: "cli" | "acp";
  chatCommand: string; // 每行一个参数
  acpCommand: string; // 每行一个参数
  cwd: string;
  pipeStdin: boolean;
  abortBytes: string;
  configEnabled: boolean;
  configPath: string;
  configFormat: "json" | "toml";
  sessionStore: "hub" | "none";
  abort: boolean;
  imageInput: boolean;
  streamText: boolean;
  /** v0.9.0 需求19：插件类型（mcp/cli/agent；提交时映射 wire kind）。 */
  pluginType: PluginType;
  toolDescription: string;
  toolUsage: string;
  toolExample: string;
  toolNotes: string;
  /** v0.9.0 需求1 二期：[mcp] 段——表单/JSON 双模式 + 三传输。 */
  mcpMode: "form" | "json";
  mcpTransport: McpTransport;
  mcpCommand: string;
  mcpArgs: string; // 空格分隔
  mcpEnv: string; // 每行 KEY=VALUE
  mcpUrl: string;
  mcpHeaders: string; // JSON 对象文本
  mcpJson: string; // JSON 模式原文
  /** v0.9.0 需求20：[skill] 段（description + SKILL.md 正文）。 */
  skillDescription: string;
  skillBody: string;
  /** v0.9.0 需求19 第八轮：[panel] 段（声明式自定义插件的核心声明面）。 */
  panelTitle: string;
  panelItems: Array<{ label: string; command: string }>;
}

interface Template {
  key: string;
  nameKey: string;
  nameFallback: string;
  icon: React.ReactNode;
  /** TOML 原文（「如何配置」的活示例，创建后即此形态）。 */
  toml: string;
  form: FormState;
  /** 该模版创建的插件类型（v0.9.0 需求19 三分）。 */
  tplKind: PluginType;
}

const emptyForm: FormState = {
  id: "",
  displayName: "",
  icon: "bot",
  installHint: "",
  probeEnabled: true,
  probeCommand: "",
  versionArgs: "--version",
  versionRegex: "",
  transportKind: "cli",
  chatCommand: "",
  acpCommand: "",
  cwd: "",
  pipeStdin: false,
  abortBytes: "",
  configEnabled: false,
  configPath: "",
  configFormat: "json",
  sessionStore: "hub",
  abort: true,
  imageInput: false,
  streamText: false,
  pluginType: "agent" as const,
  toolDescription: "",
  toolUsage: "",
  toolExample: "",
  toolNotes: "",
  mcpMode: "form" as const,
  mcpTransport: "stdio" as const,
  mcpCommand: "",
  mcpArgs: "",
  mcpEnv: "",
  mcpUrl: "",
  mcpHeaders: "",
  mcpJson: "",
  skillDescription: "",
  skillBody: "",
  panelTitle: "",
  panelItems: [],
};

/** 模版 = 表单预填常量（用户显式选择的起点，非运行时 agent 分支）。
 * 形态取自三家内置 agent 的 CLI 接入方式，路径/命令均可再编辑。 */
const templates: Template[] = [
  {
    key: "blank",
    nameKey: "plugins.tplBlank",
    nameFallback: "空白",
    icon: <Plus className="h-4 w-4" />,
    tplKind: "agent",
    toml: `schema = 1

[info]
id = "my-agent"
display_name = "My Agent"

[transport]
kind = "cli"
chat_command = ["my-agent", "{prompt}"]
`,
    form: { ...emptyForm },
  },
  {
    key: "claude",
    nameKey: "plugins.tplClaude",
    nameFallback: "基于 Claude Code",
    icon: <Sparkles className="h-4 w-4" />,
    toml: `schema = 1

[info]
id = "my-claude"
display_name = "My Claude"
install_hint = "npm install -g @anthropic-ai/claude-code"

[probe]
command = "claude"
version_args = ["--version"]

[transport]
kind = "cli"
chat_command = ["claude", "-p", "{prompt}"]
abort_bytes = "0x1b"

[config]
surface = "raw"
path = "~/.claude/settings.json"
format = "json"

[session]
store = "hub"
`,
    tplKind: "agent",
    form: {
      ...emptyForm,
      id: "my-claude",
      displayName: "My Claude",
      installHint: "npm install -g @anthropic-ai/claude-code",
      probeCommand: "claude",
      chatCommand: "claude\n-p\n{prompt}",
      abortBytes: "0x1b",
      configEnabled: true,
      configPath: "~/.claude/settings.json",
      configFormat: "json",
    },
  },
  {
    key: "codex",
    nameKey: "plugins.tplCodex",
    nameFallback: "基于 Codex",
    icon: <Terminal className="h-4 w-4" />,
    toml: `schema = 1

[info]
id = "my-codex"
display_name = "My Codex"
install_hint = "npm install -g @openai/codex"

[probe]
command = "codex"
version_args = ["--version"]

[transport]
kind = "cli"
chat_command = ["codex", "exec", "{prompt}"]

[config]
surface = "raw"
path = "~/.codex/config.toml"
format = "toml"

[session]
store = "hub"
`,
    tplKind: "agent",
    form: {
      ...emptyForm,
      id: "my-codex",
      displayName: "My Codex",
      installHint: "npm install -g @openai/codex",
      probeCommand: "codex",
      chatCommand: "codex\nexec\n{prompt}",
      configEnabled: true,
      configPath: "~/.codex/config.toml",
      configFormat: "toml",
    },
  },
  {
    key: "opencode",
    nameKey: "plugins.tplOpencode",
    nameFallback: "基于 OpenCode",
    icon: <Code2 className="h-4 w-4" />,
    toml: `schema = 1

[info]
id = "my-opencode"
display_name = "My OpenCode"
install_hint = "npm install -g opencode-ai"

[probe]
command = "opencode"
version_args = ["--version"]

[transport]
kind = "cli"
chat_command = ["opencode", "run", "{prompt}"]

[config]
surface = "raw"
path = "~/.config/opencode/opencode.json"
format = "json"

[session]
store = "hub"
`,
    tplKind: "agent",
    form: {
      ...emptyForm,
      id: "my-opencode",
      displayName: "My OpenCode",
      installHint: "npm install -g opencode-ai",
      probeCommand: "opencode",
      chatCommand: "opencode\nrun\n{prompt}",
      configEnabled: true,
      configPath: "~/.config/opencode/opencode.json",
      configFormat: "json",
    },
  },
  {
    key: "tool-gh",
    nameKey: "plugins.tplToolGh",
    nameFallback: "GitHub CLI 工具",
    icon: <Terminal className="h-4 w-4" />,
    tplKind: "cli",
    toml: `schema = 1
kind = "tool"

[info]
id = "gh"
display_name = "GitHub CLI"
install_hint = "winget install GitHub.cli"

[probe]
command = "gh"
version_args = ["--version"]

[tool]
description = "GitHub 仓库、Issue 与 PR 操作"
usage = "gh pr list --repo <owner>/<repo>"
example = "gh pr view 42"
notes = "需要 gh auth login 完成登录"
`,
    form: {
      ...emptyForm,
      pluginType: "cli",
      id: "gh",
      displayName: "GitHub CLI",
      installHint: "winget install GitHub.cli",
      probeCommand: "gh",
      toolDescription: "GitHub 仓库、Issue 与 PR 操作",
      toolUsage: "gh pr list --repo <owner>/<repo>",
      toolExample: "gh pr view 42",
      toolNotes: "需要 gh auth login 完成登录",
    },
  },
  {
    key: "tool-mcp",
    nameKey: "plugins.tplToolMcp",
    nameFallback: "MCP 工具",
    icon: <Blocks className="h-4 w-4" />,
    tplKind: "mcp",
    toml: `schema = 1
kind = "tool"

[info]
id = "my-mcp-tool"
display_name = "My MCP Tool"

[mcp]
type = "stdio"
command = "npx"
args = ["-y", "<mcp-server-package>"]
`,
    form: {
      ...emptyForm,
      pluginType: "mcp",
      id: "my-mcp-tool",
      displayName: "My MCP Tool",
      icon: "",
      mcpTransport: "stdio",
      mcpCommand: "npx",
      mcpArgs: "-y <mcp-server-package>",
    },
  },
  {
    key: "custom-blank",
    nameKey: "plugins.tplCustomPanel",
    nameFallback: "面板示例",
    icon: <Plus className="h-4 w-4" />,
    tplKind: "custom",
    toml: `schema = 1
kind = "tool"

[info]
id = "service-check"
display_name = "服务巡检"

[panel]
title = "服务状态一览"

[[panel.items]]
label = "前端站点"
command = "curl -s -o /dev/null -w \"%{http_code}\" https://app.example.com"

[[panel.items]]
label = "磁盘水位"
command = "wmic logicaldisk get caption,freespace,size"
`,
    form: {
      ...emptyForm,
      pluginType: "custom",
      id: "service-check",
      displayName: "服务巡检",
      panelTitle: "服务状态一览",
      panelItems: [
        { label: "前端站点", command: 'curl -s -o /dev/null -w "%{http_code}" https://app.example.com' },
        { label: "磁盘水位", command: "wmic logicaldisk get caption,freespace,size" },
      ],
    },
  },
  {
    key: "skill-demo",
    nameKey: "plugins.tplSkill",
    nameFallback: "Skill 示例",
    icon: <Sparkles className="h-4 w-4" />,
    tplKind: "skill",
    toml: `schema = 1
kind = "tool"

[info]
id = "code-review"
display_name = "Code Review"

[skill]
description = "提交前代码自查清单——逐文件检查错误处理与测试覆盖"
body = """逐文件检查：
1. 错误处理是否完整
2. 新逻辑是否有测试覆盖
3. 命名与既有风格一致"""
`,
    form: {
      ...emptyForm,
      pluginType: "skill",
      id: "code-review",
      displayName: "Code Review",
      icon: "",
      skillDescription: "提交前代码自查清单——逐文件检查错误处理与测试覆盖",
      skillBody: "逐文件检查：\n1. 错误处理是否完整\n2. 新逻辑是否有测试覆盖\n3. 命名与既有风格一致",
    },
  },
  {
    key: "tool-dingtalk",
    nameKey: "plugins.tplToolDingtalk",
    nameFallback: "钉钉 CLI 工具",
    icon: <Bot className="h-4 w-4" />,
    tplKind: "cli",
    toml: `schema = 1
kind = "tool"

[info]
id = "dingtalk"
display_name = "钉钉 CLI"
install_hint = "npm install -g dingtalk-cli"

[probe]
command = "dingtalk"

[tool]
description = "钉钉消息发送与群管理"
usage = "dingtalk send --to <群名> --message <内容>"
example = "dingtalk send --to 项目群 --message \"构建完成\""
notes = "需要 DINGTALK_WEBHOOK 环境变量"
`,
    form: {
      ...emptyForm,
      pluginType: "cli",
      id: "dingtalk",
      displayName: "钉钉 CLI",
      installHint: "npm install -g dingtalk-cli",
      probeCommand: "dingtalk",
      toolDescription: "钉钉消息发送与群管理",
      toolUsage: "dingtalk send --to <群名> --message <内容>",
      toolExample: "dingtalk send --to 项目群 --message \"构建完成\"",
      toolNotes: "需要 DINGTALK_WEBHOOK 环境变量",
    },
  },
];

/** 外层解包：直接 server 对象或 {"mcpServers": {...}} 包裹 → servers 对象。 */
function unwrapServersObj(
  text: string,
): { ok: true; obj: Record<string, unknown> } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: "不是合法的 JSON" };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { ok: false, error: "顶层必须是 JSON 对象" };
  }
  let obj = v as Record<string, unknown>;
  if (obj.mcpServers !== undefined) {
    if (typeof obj.mcpServers !== "object" || obj.mcpServers === null || Array.isArray(obj.mcpServers)) {
      return { ok: false, error: "mcpServers 必须是对象" };
    }
    obj = obj.mcpServers as Record<string, unknown>;
  }
  return { ok: true, obj };
}

/** 单个 server 条目解析（name 用于错误信息；单/批量共用）：
 * type 兼容 streamable-http → http；**缺省 type 按字段推断**（有 command →
 * stdio；有 url → http——外部配置常省略 type，如智谱 open.bigmodel.cn 的
 * url 型条目；sse 必须显式声明）；stdio 需 command，http/sse 需 http(s) url。 */
function parseServerEntry(
  name: string,
  cfg: Record<string, unknown>,
): { ok: true; server: McpServerEntry } | { ok: false; error: string } {
  let type = typeof cfg.type === "string" ? cfg.type.trim().toLowerCase() : "";
  if (type === "streamable-http" || type === "streamablehttp") type = "http";
  if (!type) {
    if (typeof cfg.command === "string" && cfg.command.trim()) type = "stdio";
    else if (typeof cfg.url === "string" && cfg.url.trim()) type = "http";
  }
  if (type !== "stdio" && type !== "http" && type !== "sse") {
    const reason =
      typeof cfg.type === "string" && cfg.type.trim()
        ? `不支持的传输类型 "${cfg.type}"（支持 stdio / http / sse）`
        : "缺 type 且无 command/url，无法推断传输类型";
    return { ok: false, error: `server "${name}"：${reason}` };
  }
  const stringMap = (src: unknown): Record<string, string> | undefined => {
    if (typeof src !== "object" || src === null || Array.isArray(src)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(src)) {
      if (typeof val === "string") out[k] = val;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  if (type === "stdio") {
    const command = typeof cfg.command === "string" ? cfg.command : "";
    if (!command.trim()) return { ok: false, error: `server "${name}"：stdio 类型需要填写 command` };
    return {
      ok: true,
      server: {
        type: "stdio",
        command: command.trim(),
        args: Array.isArray(cfg.args)
          ? cfg.args.filter((a): a is string => typeof a === "string")
          : undefined,
        env: stringMap(cfg.env),
      },
    };
  }
  const url = typeof cfg.url === "string" ? cfg.url.trim() : "";
  if (!url) return { ok: false, error: `server "${name}"：${type} 类型需要填写 url` };
  if (!/^https?:\/\//.test(url)) {
    return { ok: false, error: `server "${name}"：url 必须以 http:// 或 https:// 开头` };
  }
  return { ok: true, server: { type, url, headers: stringMap(cfg.headers) } };
}

/** 参考图 JSON 模式解析（单 server）：恰一个条目。 */
export function parseMcpServerJson(
  text: string,
): { ok: true; name: string; server: McpServerEntry } | { ok: false; error: string } {
  const unwrapped = unwrapServersObj(text);
  if (!unwrapped.ok) return unwrapped;
  const entries = Object.entries(unwrapped.obj);
  if (entries.length === 0) {
    return { ok: false, error: "未包含任何 MCP server" };
  }
  if (entries.length > 1) {
    return { ok: false, error: `包含 ${entries.length} 个 server——单个插件仅支持声明一个，批量请用「JSON 批量导入」` };
  }
  const [name, rawCfg] = entries[0];
  if (typeof rawCfg !== "object" || rawCfg === null || Array.isArray(rawCfg)) {
    return { ok: false, error: `server "${name}" 的配置必须是对象` };
  }
  const parsed = parseServerEntry(name, rawCfg as Record<string, unknown>);
  return parsed.ok ? { ok: true, name, server: parsed.server } : parsed;
}

/** 批量导入解析（需求19 第二轮）：1+ 条目全量校验——任一条目非法即整体
 * 报错（不部分导入），错误信息带条目名。 */
export function parseMcpServersBatch(
  text: string,
):
  | { ok: true; servers: Array<{ name: string; server: McpServerEntry }> }
  | { ok: false; error: string } {
  const unwrapped = unwrapServersObj(text);
  if (!unwrapped.ok) return unwrapped;
  const entries = Object.entries(unwrapped.obj);
  if (entries.length === 0) {
    return { ok: false, error: "未包含任何 MCP server" };
  }
  const servers: Array<{ name: string; server: McpServerEntry }> = [];
  for (const [name, rawCfg] of entries) {
    if (typeof rawCfg !== "object" || rawCfg === null || Array.isArray(rawCfg)) {
      return { ok: false, error: `server "${name}" 的配置必须是对象` };
    }
    const parsed = parseServerEntry(name, rawCfg as Record<string, unknown>);
    if (!parsed.ok) return parsed;
    servers.push({ name, server: parsed.server });
  }
  return { ok: true, servers };
}

/** 请求头文本（JSON 对象）→ Record；空文本返回 undefined；非法抛错（行内提示/提交拦截共用）。 */
function parseMcpHeaders(text: string): Record<string, string> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(trimmed);
  } catch {
    throw new Error("请求头必须是合法的 JSON 对象");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("请求头必须是合法的 JSON 对象");
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") {
      throw new Error("请求头的值必须都是字符串");
    }
    out[k] = val;
  }
  return out;
}

/** 归一化 server 条目 → [mcp] wire 段（空集合省略）。 */
export function serverToMcpSection(s: McpServerEntry): Record<string, unknown> {
  if (s.type === "stdio") {
    return {
      type: "stdio",
      command: (s.command ?? "").trim(),
      ...(s.args && s.args.length > 0 ? { args: s.args } : {}),
      ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
    };
  }
  return {
    type: s.type,
    url: (s.url ?? "").trim(),
    ...(s.headers && Object.keys(s.headers).length > 0 ? { headers: s.headers } : {}),
  };
}

/** 环境变量文本（每行 KEY=VALUE）→ Record（空行/非法行忽略）。 */
function parseEnvLines(text: string): Record<string, string> | undefined {
  const entries: [string, string][] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    const i = l.indexOf("=");
    if (i > 0) entries.push([l.slice(0, i), l.slice(i + 1)]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** server 名 → 插件 id slug（JSON 模式 name 键预填 id 用）。 */
export function mcpNameToId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "mcp-tool";
}

/** 表单 → manifest JSON（wire 结构与后端 AgentManifestFile 对齐；空值省略）。
 * MCP 区输入非法（JSON/请求头解析失败）时抛 Error（handleSubmit 捕获展示）。 */
export function buildManifest(form: FormState): Record<string, unknown> {
  if (form.pluginType !== "agent") {
    // 需求19 GUI 裁决：MCP 表单不填插件 ID——由名称 slug 自动生成（编辑时
    // form.id 已预填，走原值）。
    const toolId =
      form.id.trim() ||
      (form.pluginType === "mcp" ? mcpNameToId(form.displayName.trim() || "") : "");
    const tool: Record<string, unknown> = {
      schema: 1,
      kind: "tool",
      info: {
        id: toolId,
        display_name: form.displayName.trim(),
        ...(form.icon.trim() ? { icon: form.icon.trim() } : {}),
        ...(form.installHint.trim() ? { install_hint: form.installHint.trim() } : {}),
      },
    };
    // v0.9.0 需求12：[tool] 段条件化——仅 [mcp] 的纯结构化工具插件合法
    //（schema 既有规则），description/usage 齐备才写入。
    if (form.toolDescription.trim() && form.toolUsage.trim()) {
      tool.tool = {
        description: form.toolDescription.trim(),
        usage: form.toolUsage.trim(),
        ...(form.toolExample.trim() ? { example: form.toolExample.trim() } : {}),
        ...(form.toolNotes.trim() ? { notes: form.toolNotes.trim() } : {}),
      };
    }
    // v0.9.0 需求1 二期：[mcp] 段表单/JSON 双模式 + 三传输（stdio → spawn
    // 子进程；http/sse → 远程连接），hub 聚合 server 代理其工具。
    if (form.mcpMode === "json") {
      const text = form.mcpJson.trim();
      if (text) {
        const parsed = parseMcpServerJson(text);
        if (!parsed.ok) throw new Error(parsed.error);
        tool.mcp = serverToMcpSection(parsed.server);
      }
    } else if (form.mcpTransport === "stdio") {
      if (form.mcpCommand.trim()) {
        const env = parseEnvLines(form.mcpEnv);
        tool.mcp = {
          type: "stdio",
          command: form.mcpCommand.trim(),
          ...(form.mcpArgs.trim()
            ? { args: form.mcpArgs.split(/\s+/).filter(Boolean) }
            : {}),
          ...(env ? { env } : {}),
        };
      }
    } else {
      if (form.mcpUrl.trim()) {
        const headers = parseMcpHeaders(form.mcpHeaders);
        tool.mcp = {
          type: form.mcpTransport,
          url: form.mcpUrl.trim(),
          ...(headers ? { headers } : {}),
        };
      }
    }
    // v0.9.0 需求20：[skill] 段——SKILL.md 声明（description+body；skill 名=
    // 插件 id，hub 分发器部署到 agent skill 目录）。
    if (form.skillDescription.trim() && form.skillBody.trim()) {
      tool.skill = {
        description: form.skillDescription.trim(),
        body: form.skillBody.trim(),
      };
    }
    // v0.9.0 需求19 第八轮：[panel] 段——声明式自定义插件的核心（面板标题 +
    // 只读命令项；未填完整的行过滤，空项集不产出）。
    {
      const items = form.panelItems
        .map((it) => ({ label: it.label.trim(), command: it.command.trim() }))
        .filter((it) => it.label && it.command);
      if (form.panelTitle.trim() && items.length > 0) {
        tool.panel = { title: form.panelTitle.trim(), items };
      }
    }
    if (form.probeEnabled && form.probeCommand.trim()) {
      tool.probe = {
        command: form.probeCommand.trim(),
        ...(form.versionArgs.trim()
          ? { version_args: form.versionArgs.split(/\s+/).filter(Boolean) }
          : {}),
        ...(form.versionRegex.trim() ? { version_regex: form.versionRegex.trim() } : {}),
      };
    }
    return tool;
  }
  const manifest: Record<string, unknown> = {
    schema: 1,
    info: {
      id: form.id.trim(),
      display_name: form.displayName.trim(),
      ...(form.icon.trim() ? { icon: form.icon.trim() } : {}),
      ...(form.installHint.trim() ? { install_hint: form.installHint.trim() } : {}),
    },
    transport:
      form.transportKind === "cli"
        ? {
            kind: "cli",
            chat_command: form.chatCommand
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
            ...(form.pipeStdin ? { pipe_stdin: true } : {}),
            ...(form.abortBytes.trim() ? { abort_bytes: form.abortBytes.trim() } : {}),
          }
        : {
            kind: "acp",
            acp_command: form.acpCommand
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          },
    session: { store: form.sessionStore },
    capabilities: {
      abort: form.abort,
      image_input: form.imageInput,
      stream_text: form.streamText,
    },
  };
  if (form.probeEnabled && form.probeCommand.trim()) {
    manifest.probe = {
      command: form.probeCommand.trim(),
      ...(form.versionArgs.trim()
        ? { version_args: form.versionArgs.split(/\s+/).filter(Boolean) }
        : {}),
      ...(form.versionRegex.trim() ? { version_regex: form.versionRegex.trim() } : {}),
    };
  }
  if (form.configEnabled && form.configPath.trim()) {
    manifest.config = {
      surface: "raw",
      path: form.configPath.trim(),
      format: form.configFormat,
    };
  }
  return manifest;
}

function FieldHelp({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] leading-snug text-muted-foreground mt-1">{children}</p>;
}

/** 类型卡元数据（v0.9.0 需求19，数据驱动——SKILL 类型后续零改布局扩展）。
 * formLabel = 实现形式（总控转发 / 独立插拔），是用户选型的关键依据。 */
const PLUGIN_TYPES: Array<{
  key: PluginType;
  icon: React.ReactNode;
  nameKey: string;
  nameFallback: string;
  formKey: string;
  formFallback: string;
  descKey: string;
  descFallback: string;
  defaultTemplate: string;
}> = [
  {
    key: "mcp",
    icon: <Blocks className="h-4 w-4" />,
    nameKey: "plugins.typeMcp",
    nameFallback: "MCP 工具",
    formKey: "plugins.typeMcpForm",
    formFallback: "总控转发",
    descKey: "plugins.typeMcpDesc",
    descFallback: "声明 MCP server，经解析器统一转发，增删实时生效",
    defaultTemplate: "tool-mcp",
  },
  {
    key: "skill",
    icon: <Sparkles className="h-4 w-4" />,
    nameKey: "plugins.typeSkill",
    nameFallback: "Skill 工具",
    formKey: "plugins.typeSkillForm",
    formFallback: "总控转发",
    descKey: "plugins.typeSkillDesc",
    descFallback: "声明 SKILL.md 能力，经解析器分发到 agent skill 目录",
    defaultTemplate: "skill-demo",
  },
  {
    key: "cli",
    icon: <Terminal className="h-4 w-4" />,
    nameKey: "plugins.typeCli",
    nameFallback: "CLI 工具",
    formKey: "plugins.typeCliForm",
    formFallback: "独立插拔",
    descKey: "plugins.typeCliDesc",
    descFallback: "声明命令用法，会话注入后由智能体 shell 执行",
    defaultTemplate: "tool-gh",
  },
  {
    key: "custom",
    icon: <Plus className="h-4 w-4" />,
    nameKey: "plugins.typeCustom",
    nameFallback: "自定义插件",
    formKey: "plugins.typeCustomForm",
    formFallback: "独立插拔",
    descKey: "plugins.typeCustomDesc",
    descFallback: "声明管理面板（只读命令集），可选附带用法注入",
    defaultTemplate: "custom-blank",
  },
  {
    key: "agent",
    icon: <Bot className="h-4 w-4" />,
    nameKey: "plugins.typeAgent",
    nameFallback: "智能体",
    formKey: "plugins.typeAgentForm",
    formFallback: "独立插拔",
    descKey: "plugins.typeAgentDesc",
    descFallback: "接入一个独立 CLI/ACP 智能体，单独启停管理",
    defaultTemplate: "blank",
  },
];

function Labeled({
  labelKey,
  fallback,
  children,
  help,
}: {
  labelKey: string;
  fallback: string;
  children: React.ReactNode;
  help?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const label = t(labelKey) === labelKey ? fallback : t(labelKey);
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {help && <FieldHelp>{help}</FieldHelp>}
    </div>
  );
}

/** manifest JSON（plugin_get 返回）→ 表单状态（buildManifest 的逆映射；导出供测试）。 */
export function parseManifest(json: Record<string, unknown>): {
  form: FormState;
  /** M4：表单不可表达的段（[pi_extension]）——编辑往返原样保留，随提交
   * 原文透传（修前 parse 丢弃 + build 覆盖写回 = 静默数据丢失）。 */
  preserved: Record<string, unknown>;
} {
  const info = (json.info ?? {}) as Record<string, unknown>;
  const probe = json.probe as Record<string, unknown> | undefined;
  const transport = (json.transport ?? {}) as Record<string, unknown>;
  const config = json.config as Record<string, unknown> | undefined;
  const session = (json.session ?? {}) as Record<string, unknown>;
  const caps = (json.capabilities ?? {}) as Record<string, unknown>;
  const tool = (json.tool ?? {}) as Record<string, unknown>;
  const mcp = json.mcp as Record<string, unknown> | undefined;
  const skillSec = json.skill as Record<string, unknown> | undefined;
  const panelSec = json.panel as Record<string, unknown> | undefined;
  const preserved: Record<string, unknown> = {};
  if (json.pi_extension && typeof json.pi_extension === "object") {
    preserved.pi_extension = json.pi_extension;
  }
  const form: FormState = {
    id: String(info.id ?? ""),
    displayName: String(info.display_name ?? ""),
    icon: String(info.icon ?? ""),
    installHint: String(info.install_hint ?? ""),
    probeEnabled: !!probe,
    probeCommand: String(probe?.command ?? ""),
    versionArgs: Array.isArray(probe?.version_args)
      ? (probe!.version_args as string[]).join(" ")
      : "",
    versionRegex: String(probe?.version_regex ?? ""),
    transportKind: transport.kind === "acp" ? "acp" : "cli",
    chatCommand: Array.isArray(transport.chat_command)
      ? (transport.chat_command as string[]).join("\n")
      : "",
    acpCommand: Array.isArray(transport.acp_command)
      ? (transport.acp_command as string[]).join("\n")
      : "",
    cwd: String(transport.cwd ?? ""),
    pipeStdin: transport.pipe_stdin === true,
    abortBytes: String(transport.abort_bytes ?? ""),
    configEnabled: !!config,
    configPath: String(config?.path ?? ""),
    configFormat: config?.format === "toml" ? "toml" : "json",
    sessionStore: session.store === "none" ? "none" : "hub",
    abort: caps.abort !== false,
    imageInput: caps.image_input === true,
    streamText: caps.stream_text === true,
    pluginType:
      json.kind === "tool"
        ? mcp
          ? "mcp"
          : skillSec
            ? "skill"
            : panelSec
              ? "custom" // 声明式面板插件（需求19 第八轮形态）
              : "cli"
        : "agent",
    toolDescription: String(tool.description ?? ""),
    toolUsage: String(tool.usage ?? ""),
    toolExample: String(tool.example ?? ""),
    toolNotes: String(tool.notes ?? ""),
    // v0.9.0 需求1 二期：[mcp] 三传输往返（表单模式回填；JSON 草稿为空）。
    mcpMode: "form",
    mcpTransport:
      mcp?.type === "http" ? "http" : mcp?.type === "sse" ? "sse" : "stdio",
    mcpCommand: String(mcp?.command ?? ""),
    mcpArgs: Array.isArray(mcp?.args) ? (mcp!.args as string[]).join(" ") : "",
    mcpEnv:
      mcp && mcp.env && typeof mcp.env === "object"
        ? Object.entries(mcp.env as Record<string, unknown>)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join("\n")
        : "",
    mcpUrl: String(mcp?.url ?? ""),
    mcpHeaders:
      mcp && mcp.headers && typeof mcp.headers === "object"
        ? JSON.stringify(mcp.headers, null, 2)
        : "",
    mcpJson: "",
    skillDescription: String(skillSec?.description ?? ""),
    skillBody: String(skillSec?.body ?? ""),
    panelTitle: String(panelSec?.title ?? ""),
    panelItems: Array.isArray(panelSec?.items)
      ? (panelSec!.items as Array<Record<string, unknown>>).map((it) => ({
          label: String(it.label ?? ""),
          command: String(it.command ?? ""),
        }))
      : [],
  };
  return { form, preserved };
}

export function PluginCreateDialog({
  open,
  onOpenChange,
  onCreated,
  editPluginId,
  mcpResolverEnabled = true,
  skillResolverEnabled = true,
}: CreateProps) {
  const { t } = useTranslation();
  const { alert: alertDialog, dialogNode } = useConfirmDialog();
  const [templateKey, setTemplateKey] = useState("blank");
  const [form, setForm] = useState<FormState>(templates[0].form);
  /** M4：编辑时表单不可表达的段（[pi_extension]），提交时原文透传。 */
  const [preservedSections, setPreservedSections] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = !!editPluginId;

  // 编辑模式：打开时拉取现有 manifest 预填（失败则表单保持原样并提示）。
  useEffect(() => {
    if (!open || !editPluginId) return;
    setError(null);
    invokeCommand<Record<string, unknown>>("plugin_get", { pluginId: editPluginId })
      .then((json) => {
        if (json) {
          const parsed = parseManifest(json);
          setForm(parsed.form);
          setPreservedSections(parsed.preserved);
        }
      })
      .catch((err) => setError(String(err)));
  }, [open, editPluginId]);

  const tr = (key: string, fallback: string) => (t(key) === key ? fallback : t(key));
  const template = useMemo(
    () => templates.find((tp) => tp.key === templateKey) ?? templates[0],
    [templateKey],
  );

  const pickTemplate = (key: string) => {
    const tp = templates.find((x) => x.key === key);
    if (!tp) return;
    setTemplateKey(key);
    // M4：编辑模式点模板不再整体重置表单（会覆盖被锁定的 id，提交必然后端
    // 拒绝）——保留 id/display_name，只带模板的段默认值。
    setForm((prev) =>
      isEdit
        ? { ...tp.form, id: prev.id, displayName: prev.displayName }
        : { ...tp.form },
    );
    setError(null);
  };

  const patch = (partial: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...partial }));

  const pluginType = form.pluginType;
  const isTool = pluginType !== "agent";
  /** 解析器关闭且非编辑（既有 MCP 插件仍可编辑）→ MCP 区不可添加。 */
  const mcpLocked = pluginType === "mcp" && !mcpResolverEnabled && !isEdit;
  /** skill 解析器关闭且非编辑 → SKILL 区不可添加（需求20，同 MCP 语义）。 */
  const skillLocked = pluginType === "skill" && !skillResolverEnabled && !isEdit;

  // MCP 区行内校验（阻止提交 + 即时反馈）。
  const mcpJsonParsed = useMemo(
    () =>
      pluginType === "mcp" && form.mcpMode === "json" && form.mcpJson.trim()
        ? parseMcpServerJson(form.mcpJson)
        : null,
    [pluginType, form.mcpMode, form.mcpJson],
  );
  const mcpJsonError = mcpJsonParsed && !mcpJsonParsed.ok ? mcpJsonParsed.error : null;
  const mcpHeadersError = useMemo(() => {
    if (pluginType !== "mcp" || form.mcpMode !== "form" || form.mcpTransport === "stdio")
      return null;
    if (!form.mcpHeaders.trim()) return null;
    try {
      parseMcpHeaders(form.mcpHeaders);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [pluginType, form.mcpMode, form.mcpTransport, form.mcpHeaders]);

  // JSON 模式 name 键预填 id/显示名（仅新建且未填写时；插件 id 即 server 名
  // 的 slug 化——参考图「名称」字段的等价物）。
  useEffect(() => {
    if (!mcpJsonParsed?.ok || isEdit) return;
    if (form.id.trim() || form.displayName.trim()) return;
    patch({
      id: mcpNameToId(mcpJsonParsed.name),
      displayName: mcpJsonParsed.name,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpJsonParsed, isEdit]);

  /** 表单 | JSON 双向切换：表单 → JSON 按当前表单态生成草稿；JSON → 表单
   * 解析成功则回填分传输字段（失败保持表单原值，草稿保留在 JSON 文本）。 */
  const switchMcpMode = (mode: "form" | "json") => {
    if (mode === form.mcpMode) return;
    if (mode === "json") {
      const entry: McpServerEntry =
        form.mcpTransport === "stdio"
          ? {
              type: "stdio",
              command: form.mcpCommand.trim(),
              // args 恒展示（空为 []）——stdio 的参数位在 JSON 里可见可改
              //（GUI 反馈：表单切 JSON 时空参数不应整段消失）。
              args: form.mcpArgs.trim()
                ? form.mcpArgs.split(/\s+/).filter(Boolean)
                : [],
              ...(parseEnvLines(form.mcpEnv) ? { env: parseEnvLines(form.mcpEnv) } : {}),
            }
          : {
              type: form.mcpTransport,
              url: form.mcpUrl.trim(),
            };
      const name = form.id.trim() || "my-mcp-server";
      patch({
        mcpMode: "json",
        mcpJson: JSON.stringify({ [name]: entry }, null, 2),
      });
      return;
    }
    const parsed = form.mcpJson.trim() ? parseMcpServerJson(form.mcpJson) : null;
    if (parsed?.ok) {
      const s = parsed.server;
      patch({
        mcpMode: "form",
        mcpTransport: s.type,
        mcpCommand: s.command ?? form.mcpCommand,
        mcpArgs: s.args?.length ? s.args.join(" ") : form.mcpArgs,
        mcpEnv: s.env
          ? Object.entries(s.env)
              .map(([k, v]) => `${k}=${v}`)
              .join("\n")
          : form.mcpEnv,
        mcpUrl: s.url ?? form.mcpUrl,
        mcpHeaders: s.headers ? JSON.stringify(s.headers, null, 2) : form.mcpHeaders,
      });
    } else {
      patch({ mcpMode: "form" });
    }
  };

  /** MCP 区产出是否就绪（解析器锁定时恒 false）。 */
  const mcpReady = mcpLocked
    ? false
    : form.mcpMode === "json"
      ? !!mcpJsonParsed?.ok
      : form.mcpTransport === "stdio"
        ? form.mcpCommand.trim().length > 0
        : form.mcpUrl.trim().length > 0 && !mcpHeadersError;

  const effectiveId =
    form.id.trim() ||
    (pluginType === "mcp" ? mcpNameToId(form.displayName.trim() || "") : "");
  const canSubmit =
    effectiveId.length > 0 &&
    form.displayName.trim().length > 0 &&
    !mcpJsonError &&
    (pluginType === "mcp"
      ? mcpReady ||
        (form.toolDescription.trim().length > 0 && form.toolUsage.trim().length > 0)
      : pluginType === "skill"
        ? form.skillDescription.trim().length > 0 && form.skillBody.trim().length > 0
        : pluginType === "custom"
          ? (form.panelTitle.trim().length > 0 &&
              form.panelItems.some((it) => it.label.trim() && it.command.trim())) ||
            (form.toolDescription.trim().length > 0 && form.toolUsage.trim().length > 0)
          : pluginType === "cli"
        ? form.toolDescription.trim().length > 0 && form.toolUsage.trim().length > 0
        : form.transportKind === "cli"
          ? form.chatCommand.trim().length > 0
          : form.acpCommand.trim().length > 0);

  /** 切换插件类型：保留表单字段（互不干扰），模版高亮切到该类型默认模版。 */
  const pickType = (type: PluginType) => {
    if (isEdit || type === pluginType) return;
    patch({ pluginType: type });
    const tpl = templates.find((x) => x.tplKind === type);
    if (tpl) setTemplateKey(tpl.key);
  };

  /** MCP JSON 批量导入（需求19 第二轮）：多 server → 多插件，逐条落盘。 */
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchJson, setBatchJson] = useState("");
  const [importing, setImporting] = useState(false);
  const batchParsed = useMemo(
    () => (batchOpen && batchJson.trim() ? parseMcpServersBatch(batchJson) : null),
    [batchOpen, batchJson],
  );

  const handleBatchImport = async () => {
    if (!batchParsed?.ok) return;
    setImporting(true);
    try {
      const created: string[] = [];
      const failed: string[] = [];
      for (const { name, server } of batchParsed.servers) {
        const manifest = {
          schema: 1,
          kind: "tool",
          info: { id: mcpNameToId(name), display_name: name },
          mcp: serverToMcpSection(server),
        };
        try {
          await invokeCommand("plugin_create", { manifest });
          created.push(name);
        } catch (createErr) {
          // 同名已存在 → 覆盖更新（GUI 反馈裁决：批量导入直接覆盖，整段
          // manifest 以导入内容为准）；更新也失败才计为失败。
          try {
            await invokeCommand("plugin_update", {
              pluginId: manifest.info.id,
              manifest,
            });
            created.push(`${name}（覆盖）`);
          } catch {
            failed.push(`${name}: ${String(createErr)}`);
          }
        }
      }
      setBatchOpen(false);
      if (created.length > 0) onCreated();
      void alertDialog({
        title: tr("plugins.mcpBatchTitle", "批量导入 MCP 服务"),
        description:
          `${tr("plugins.mcpBatchDone", "导入完成")}：成功 ${created.length} 个` +
          (failed.length
            ? `；失败 ${failed.length} 个：\n${failed.join("\n")}`
            : ""),
      });
    } finally {
      setImporting(false);
    }
  };

  /** [tool] 声明字段集（CLI = 核心分组；MCP = 高级折叠，共用字段）。 */
  const toolDeclareFields = (
    <>
      <Labeled labelKey="plugins.fToolDesc" fallback="描述 *">
        <Input
          value={form.toolDescription}
          onChange={(e) => patch({ toolDescription: e.target.value })}
          placeholder="钉钉消息发送与群管理"
          className="h-8 text-xs"
        />
        <FieldHelp>{tr("plugins.hToolDesc", "")}</FieldHelp>
      </Labeled>
      <Labeled labelKey="plugins.fToolUsage" fallback="用法 *">
        <Input
          value={form.toolUsage}
          onChange={(e) => patch({ toolUsage: e.target.value })}
          placeholder="dingtalk send --to <群名> --message <内容>"
          className="h-8 text-xs font-mono"
        />
        <FieldHelp>{tr("plugins.hToolUsage", "")}</FieldHelp>
      </Labeled>
      <div className="grid grid-cols-2 gap-3">
        <Labeled labelKey="plugins.fToolExample" fallback="示例">
          <Input
            value={form.toolExample}
            onChange={(e) => patch({ toolExample: e.target.value })}
            className="h-8 text-xs font-mono"
          />
        </Labeled>
        <Labeled labelKey="plugins.fToolNotes" fallback="注意">
          <Input
            value={form.toolNotes}
            onChange={(e) => patch({ toolNotes: e.target.value })}
            placeholder="需要 XXX 环境变量"
            className="h-8 text-xs font-mono"
          />
        </Labeled>
      </div>
    </>
  );

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // M4：编辑时把表单不可表达的段（[pi_extension]）原样并回 manifest——
      // 编辑往返不再丢段。
      const manifest = { ...buildManifest(form), ...preservedSections };
      const created = isEdit
        ? await invokeCommand<{ id: string; path: string }>("plugin_update", {
            pluginId: editPluginId,
            manifest,
          })
        : await invokeCommand<{ id: string; path: string }>("plugin_create", {
            manifest,
          });
      onOpenChange(false);
      onCreated();
      void alertDialog({
        title: isEdit
          ? tr("plugins.updatedTitle", "插件已保存")
          : tr("plugins.createdTitle", "插件已创建"),
        description:
          (isEdit ? tr("plugins.updatedDesc", "") : tr("plugins.createdDesc", "")) +
          ` ${created.path}`,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {dialogNode}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>{isEdit ? tr("plugins.editTitle", "编辑插件") : tr("plugins.createTitle", "新建插件")}</DialogTitle>
            <DialogDescription>{tr("plugins.createDesc", "")}</DialogDescription>
          </DialogHeader>

          {/* 固定区（GUI 裁决 2026-09-05：类型/模版/创建按钮常驻可视，不随
           * 表单滚动——按钮永不溢出屏幕）；仅下方表单区滚动。 */}
          <div className="shrink-0 space-y-5 px-1">
            {/* 需求19：类型优先三卡（MCP/CLI/AGENT，实现形式入卡）——
             * 选中类型决定下方分组（分治渲染，消除"上面和下面什么关系"）。 */}
            <div>
              <p className="text-xs font-medium mb-2">{tr("plugins.typeSection", "插件类型")}</p>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {PLUGIN_TYPES.map((tp) => (
                  <button
                    key={tp.key}
                    type="button"
                    role="radio"
                    aria-checked={pluginType === tp.key}
                    disabled={isEdit}
                    onClick={() => pickType(tp.key)}
                    className={cn(
                      "flex flex-col items-start gap-1.5 rounded-md border p-3 text-left transition-colors",
                      pluginType === tp.key
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border/60 hover:border-primary/40 text-foreground",
                      isEdit && "opacity-60 cursor-not-allowed",
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      {tp.icon}
                      <span className="text-xs font-medium">{tr(tp.nameKey, tp.nameFallback)}</span>
                    </span>
                    <Badge variant="outline" className="px-1.5 text-[9px] leading-4 text-muted-foreground">
                      {tr(tp.formKey, tp.formFallback)}
                    </Badge>
                    <span className="text-[10px] leading-snug text-muted-foreground">
                      {tr(tp.descKey, tp.descFallback)}
                    </span>
                  </button>
                ))}
              </div>
              {isEdit && (
                <FieldHelp>{tr("plugins.hKindLockedEdit", "编辑模式不可更改插件类型（id 与文件名/会话归属均以 id 为键）")}</FieldHelp>
              )}
            </div>

            {/* 模版（仅当前类型；类型已选定，分组标签冗余——需求19 去噪） */}
            <div>
              <p className="text-xs font-medium mb-2">{tr("plugins.tplSection", "从模版开始")}</p>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {templates
                  .filter((tp) => tp.tplKind === pluginType)
                  .map((tp) => (
                    <button
                      key={tp.key}
                      type="button"
                      onClick={() => pickTemplate(tp.key)}
                      className={cn(
                        "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors",
                        templateKey === tp.key
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border/60 hover:border-primary/40",
                      )}
                    >
                      {tp.icon}
                      <span className="text-center leading-tight">{tr(tp.nameKey, tp.nameFallback)}</span>
                    </button>
                  ))}
                {pluginType === "mcp" && !mcpLocked && (
                  <button
                    type="button"
                    onClick={() => {
                      setBatchJson("");
                      setBatchOpen(true);
                    }}
                    className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border/70 p-3 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                  >
                    <FileJson className="h-4 w-4" />
                    <span className="text-center leading-tight">{tr("plugins.mcpBatchImport", "JSON 批量导入")}</span>
                  </button>
                )}
              </div>
              {/* 模版 TOML 参考行 + 创建按钮（编辑区右上角，GUI 裁决同轮）。 */}
              <div className="mt-2 flex items-start justify-between gap-2">
                <details className="group min-w-0 flex-1">
                  <summary className="text-[11px] text-muted-foreground cursor-pointer select-none">
                    {tr("plugins.viewToml", "查看模版 TOML（manifest 格式参考）")}
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/60 p-3 text-[10px] leading-relaxed">
                    {template.toml}
                  </pre>
                </details>
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                    {tr("common.cancel", "取消")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={!canSubmit || submitting}
                    onClick={handleSubmit}
                  >
                    {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {isEdit ? tr("plugins.saveAction", "保存修改") : tr("plugins.createAction", "创建")}
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* 表单滚动区：基本信息 + 类型专属分组 + 探测（上方固定区不动）。 */}
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-1 pb-2">
            {/* 基本信息——MCP 只取名称（插件 ID 由名称 slug 自动生成；图标/
             * 安装提示是 CLI/AGENT 元数据，MCP 不展示，v0.9.0 需求19 GUI 裁决）。 */}
            {pluginType === "mcp" ? (
              <div className="grid grid-cols-2 gap-3">
                <Labeled labelKey="plugins.fName" fallback="名称 *">
                  <Input
                    value={form.displayName}
                    onChange={(e) => patch({ displayName: e.target.value })}
                    placeholder="my-mcp-server"
                    className="h-8 text-xs"
                  />
                  <FieldHelp>
                    {tr("plugins.hMcpNameAuto", "插件 ID 由名称自动生成")}
                    <code className="ml-1 font-mono">
                      {form.id.trim() || mcpNameToId(form.displayName.trim() || "my-mcp-server")}
                    </code>
                  </FieldHelp>
                </Labeled>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Labeled labelKey="plugins.fId" fallback="插件 ID *">
                  <Input
                    value={form.id}
                    onChange={(e) => patch({ id: e.target.value })}
                    placeholder="my-agent"
                    className="h-8 text-xs"
                    disabled={isEdit}
                  />
                  <FieldHelp>
                    {isEdit ? tr("plugins.hIdLocked", "") : tr("plugins.hId", "")}
                  </FieldHelp>
                </Labeled>
                <Labeled labelKey="plugins.fName" fallback="显示名称 *">
                  <Input
                    value={form.displayName}
                    onChange={(e) => patch({ displayName: e.target.value })}
                    placeholder="My Agent"
                    className="h-8 text-xs"
                  />
                </Labeled>
                <Labeled labelKey="plugins.fIcon" fallback="图标标识">
                  <Input
                    value={form.icon}
                    onChange={(e) => patch({ icon: e.target.value })}
                    placeholder="bot"
                    className="h-8 text-xs"
                  />
                </Labeled>
                <Labeled labelKey="plugins.fInstallHint" fallback="安装提示命令">
                  <Input
                    value={form.installHint}
                    onChange={(e) => patch({ installHint: e.target.value })}
                    placeholder="npm install -g xxx"
                    className="h-8 text-xs font-mono"
                  />
                  <FieldHelp>{tr("plugins.hInstallHint", "")}</FieldHelp>
                </Labeled>
              </div>
            )}

            {/* 自定义插件（需求19 第八轮·声明式能力插件）：核心 = 管理面板声明
             *（面板标题 + 只读命令项，hub 渲染执行——零代码零脚本）。 */}
            {pluginType === "custom" && (
              <div className="rounded-md border border-border/50 p-3 space-y-3">
                <p className="text-xs font-medium">{tr("plugins.panelSectionTitle", "管理面板声明")}</p>
                <Labeled labelKey="plugins.fPanelTitle" fallback="面板标题 *">
                  <Input
                    value={form.panelTitle}
                    onChange={(e) => patch({ panelTitle: e.target.value })}
                    placeholder="服务状态一览"
                    className="h-8 text-xs"
                  />
                  <FieldHelp>{tr("plugins.hPanelTitle", "创建后插件页出现「面板」入口，逐项执行命令展示输出。")}</FieldHelp>
                </Labeled>
                <div className="space-y-2">
                  {form.panelItems.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input
                        value={item.label}
                        onChange={(e) =>
                          patch({
                            panelItems: form.panelItems.map((it, i) =>
                              i === idx ? { ...it, label: e.target.value } : it,
                            ),
                          })
                        }
                        placeholder={tr("plugins.fPanelItemLabel", "标签 *")}
                        className="h-8 w-36 shrink-0 text-xs"
                      />
                      <Input
                        value={item.command}
                        onChange={(e) =>
                          patch({
                            panelItems: form.panelItems.map((it, i) =>
                              i === idx ? { ...it, command: e.target.value } : it,
                            ),
                          })
                        }
                        placeholder='curl -s -o /dev/null -w "%{http_code}" https://…'
                        className="h-8 min-w-0 flex-1 text-xs font-mono"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={tr("plugins.removePanelItem", "删除该项")}
                        onClick={() =>
                          patch({ panelItems: form.panelItems.filter((_, i) => i !== idx) })
                        }
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      patch({ panelItems: [...form.panelItems, { label: "", command: "" }] })
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {tr("plugins.addPanelItem", "添加面板项")}
                  </Button>
                  <FieldHelp>{tr("plugins.hPanelItem", "面板中点击执行并展示输出（10s 超时 / 4KB 截断护栏）；未填完整的行不产出。")}</FieldHelp>
                </div>
              </div>
            )}

            {/* 自定义插件附加声明（折叠，可选）：用法注入 [tool]——教会 agent
             * 面板命令的用法。 */}
            {pluginType === "custom" && (
              <details className="rounded-md border border-border/50 p-3">
                <summary className="cursor-pointer select-none text-xs font-medium">
                  {tr("plugins.customExtraSection", "附加声明（可选）：用法注入")}
                </summary>
                <div className="mt-3 space-y-3">{toolDeclareFields}</div>
              </details>
            )}

            {/* CLI 类型核心分组：工具能力声明（会话注入的用法说明）。 */}
            {pluginType === "cli" && (
              <div className="rounded-md border border-border/50 p-3 space-y-3">
                <p className="text-xs font-medium">{tr("plugins.toolSection", "工具能力声明")}</p>
                {toolDeclareFields}
              </div>
            )}

            {/* MCP server 声明（v0.9.0 需求1 二期：表单/JSON 双模式 + 三传输；
             * 解析器未启用且非编辑 → 提示锁定）。 */}
            {pluginType === "mcp" &&
              (mcpLocked ? (
                <div className="rounded-md border border-dashed border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
                  {tr("plugins.mcpResolverDisabled", "需先启用「MCP 解析器」插件后才能添加 MCP 工具")}
                </div>
              ) : (
                <div className="rounded-md border border-border/50 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium">{tr("plugins.mcpSection", "MCP server 声明")}</p>
                    <div className="flex gap-1">
                      {(["form", "json"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => switchMcpMode(mode)}
                          className={cn(
                            "rounded-full border px-2.5 py-0.5 text-[10px] transition-colors",
                            form.mcpMode === mode
                              ? "border-primary bg-primary/5 text-primary"
                              : "border-border/60 text-muted-foreground",
                          )}
                        >
                          {mode === "form"
                            ? tr("plugins.mcpModeForm", "表单")
                            : tr("plugins.mcpModeJson", "JSON")}
                        </button>
                      ))}
                    </div>
                  </div>

                  {form.mcpMode === "form" ? (
                    <>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-muted-foreground">{tr("plugins.mcpTransportType", "传输类型")}</span>
                        {(["stdio", "http", "sse"] as const).map((tp) => (
                          <button
                            key={tp}
                            type="button"
                            onClick={() => patch({ mcpTransport: tp })}
                            className={cn(
                              "rounded-full border px-2.5 py-0.5 text-[10px] transition-colors",
                              form.mcpTransport === tp
                                ? "border-primary bg-primary/5 text-primary"
                                : "border-border/60 text-muted-foreground",
                            )}
                          >
                            {tp === "stdio"
                              ? tr("plugins.mcpTransportStdio", "stdio（本地命令）")
                              : tp === "http"
                                ? tr("plugins.mcpTransportHttp", "HTTP")
                                : tr("plugins.mcpTransportSse", "SSE（Server-Sent Events）")}
                          </button>
                        ))}
                      </div>
                      {form.mcpTransport === "stdio" ? (
                        <>
                          <Labeled labelKey="plugins.fMcpCommand" fallback="命令">
                            <Input
                              value={form.mcpCommand}
                              onChange={(e) => patch({ mcpCommand: e.target.value })}
                              placeholder="npx"
                              className="h-8 text-xs font-mono"
                            />
                            <FieldHelp>{tr("plugins.hMcpCommand", "")}</FieldHelp>
                          </Labeled>
                          <div className="grid grid-cols-2 gap-3">
                            <Labeled labelKey="plugins.fMcpArgs" fallback="参数">
                              <Input
                                value={form.mcpArgs}
                                onChange={(e) => patch({ mcpArgs: e.target.value })}
                                placeholder="-y @modelcontextprotocol/server-filesystem"
                                className="h-8 text-xs font-mono"
                              />
                              <FieldHelp>{tr("plugins.hMcpArgs", "空格分隔。")}</FieldHelp>
                            </Labeled>
                            <Labeled labelKey="plugins.fMcpEnv" fallback="环境变量">
                              <textarea
                                value={form.mcpEnv}
                                onChange={(e) => patch({ mcpEnv: e.target.value })}
                                placeholder={"API_TOKEN=xxx\nDEBUG=1"}
                                className="min-h-[2.4rem] w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs font-mono"
                              />
                              <FieldHelp>{tr("plugins.hMcpEnv", "每行 KEY=VALUE。")}</FieldHelp>
                            </Labeled>
                          </div>
                        </>
                      ) : (
                        <div className="grid grid-cols-2 gap-3">
                          <Labeled labelKey="plugins.fMcpUrl" fallback="URL">
                            <Input
                              value={form.mcpUrl}
                              onChange={(e) => patch({ mcpUrl: e.target.value })}
                              placeholder="https://mcp.example.com/mcp"
                              className="h-8 text-xs font-mono"
                            />
                            <FieldHelp>{tr("plugins.hMcpUrl", "")}</FieldHelp>
                          </Labeled>
                          <Labeled labelKey="plugins.fMcpHeaders" fallback="请求头（JSON，可选）">
                            <textarea
                              value={form.mcpHeaders}
                              onChange={(e) => patch({ mcpHeaders: e.target.value })}
                              placeholder={'{"Authorization": "Bearer your-token"}'}
                              className="min-h-[2.4rem] w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs font-mono"
                            />
                            <FieldHelp>
                              {mcpHeadersError ? (
                                <span className="text-destructive">{mcpHeadersError}</span>
                              ) : (
                                tr("plugins.hMcpHeaders", "")
                              )}
                            </FieldHelp>
                          </Labeled>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <textarea
                        value={form.mcpJson}
                        onChange={(e) => patch({ mcpJson: e.target.value })}
                        placeholder={'{\n  "my-mcp-server": {\n    "type": "stdio",\n    "command": "",\n    "args": []\n  }\n}'}
                        rows={8}
                        spellCheck={false}
                        className="flex w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-mono"
                      />
                      {mcpJsonError ? (
                        <p className="text-[11px] leading-snug text-destructive">{mcpJsonError}</p>
                      ) : (
                        <FieldHelp>{tr("plugins.hMcpJson", "")}</FieldHelp>
                      )}
                    </>
                  )}
                </div>
              ))}

            {/* Skill 声明（v0.9.0 需求20，对标 MCP 区）：description = SKILL.md
             * frontmatter，body = 正文；skill 名 = 插件 id（自动派生）。 */}
            {pluginType === "skill" &&
              (skillLocked ? (
                <div className="rounded-md border border-dashed border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
                  {tr("plugins.skillResolverDisabled", "需先启用「Skill 解析器」插件后才能添加 Skill 工具")}
                </div>
              ) : (
                <div className="rounded-md border border-border/50 p-3 space-y-3">
                  <p className="text-xs font-medium">{tr("plugins.skillSection", "Skill 声明")}</p>
                  <Labeled labelKey="plugins.fSkillDesc" fallback="描述 *">
                    <Input
                      value={form.skillDescription}
                      onChange={(e) => patch({ skillDescription: e.target.value })}
                      placeholder="提交前代码自查：何时用/做什么（≤1024 字符）"
                      className="h-8 text-xs"
                    />
                    <FieldHelp>{tr("plugins.hSkillDesc", "SKILL.md 的 frontmatter 描述——agent 按此判断何时使用该 skill。")}</FieldHelp>
                  </Labeled>
                  <Labeled labelKey="plugins.fSkillBody" fallback="内容 *">
                    <textarea
                      value={form.skillBody}
                      onChange={(e) => patch({ skillBody: e.target.value })}
                      rows={8}
                      spellCheck={false}
                      placeholder={"第一步：通读 diff…\n第二步：检查错误处理…"}
                      className="flex w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-mono"
                    />
                    <FieldHelp>{tr("plugins.hSkillBody", "SKILL.md 正文指令；启用后自动分发到各 agent 的 skill 目录（启停即分发/回收）。")}</FieldHelp>
                  </Labeled>
                </div>
              ))}

            {/* 探测（仅 CLI/AGENT——MCP 表单只保留 MCP 本质字段，stdio 命令
             * 检测并入总控监控是后续路线；MCP 编辑时 probe 段值经表单状态
             * 原样保留提交）。 */}
            {pluginType !== "mcp" && (
<div className="rounded-md border border-border/50 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">{tr("plugins.probeSection", "安装探测")}{
                pluginType === "cli" ? (
                  <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">{tr("plugins.probeToolHint", "（检测工具命令是否已安装，影响注入块的「状态」行）")}</span>
                ) : null
              }</p>
                <Switch
                  checked={form.probeEnabled}
                  onCheckedChange={(v) => patch({ probeEnabled: v })}
                />
              </div>
              {form.probeEnabled && (
                <div className="grid grid-cols-3 gap-3">
                  <Labeled labelKey="plugins.fProbeCmd" fallback="命令 *">
                    <Input
                      value={form.probeCommand}
                      onChange={(e) => patch({ probeCommand: e.target.value })}
                      placeholder="gemini"
                      className="h-8 text-xs font-mono"
                    />
                    <FieldHelp>{tr("plugins.hProbeCmd", "")}</FieldHelp>
                  </Labeled>
                  <Labeled labelKey="plugins.fVersionArgs" fallback="版本参数">
                    <Input
                      value={form.versionArgs}
                      onChange={(e) => patch({ versionArgs: e.target.value })}
                      placeholder="--version"
                      className="h-8 text-xs font-mono"
                    />
                  </Labeled>
                  <Labeled labelKey="plugins.fVersionRegex" fallback="版本正则">
                    <Input
                      value={form.versionRegex}
                      onChange={(e) => patch({ versionRegex: e.target.value })}
                      placeholder="v([0-9.]+)"
                      className="h-8 text-xs font-mono"
                    />
                    <FieldHelp>{tr("plugins.hVersionRegex", "")}</FieldHelp>
                  </Labeled>
                </div>
              )}
            </div>
)}

            {/* 传输（仅智能体插件——工具插件无 transport 段，schema 互斥） */}
            {!isTool && (
            <div className="rounded-md border border-border/50 p-3 space-y-3">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium">{tr("plugins.transportSection", "传输方式")}</p>
                {(["cli", "acp"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => patch({ transportKind: kind })}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-[10px] transition-colors",
                      form.transportKind === kind
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border/60 text-muted-foreground",
                    )}
                  >
                    {kind === "cli" ? "CLI 进程" : "ACP 协议"}
                  </button>
                ))}
              </div>
              {form.transportKind === "cli" ? (
                <div className="grid grid-cols-2 gap-3">
                  <Labeled labelKey="plugins.fChatCommand" fallback="会话命令 *（每行一个参数）">
                    <textarea
                      value={form.chatCommand}
                      onChange={(e) => patch({ chatCommand: e.target.value })}
                      placeholder={"gemini\n--prompt\n{prompt}"}
                      rows={3}
                      className="flex w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-mono"
                    />
                    <FieldHelp>{tr("plugins.hChatCommand", "")}</FieldHelp>
                  </Labeled>
                  <div className="space-y-3">
                    <Labeled labelKey="plugins.fCwd" fallback="工作目录模板">
                      <Input
                        value={form.cwd}
                        onChange={(e) => patch({ cwd: e.target.value })}
                        placeholder="{cwd}"
                        className="h-8 text-xs font-mono"
                      />
                    </Labeled>
                    <Labeled labelKey="plugins.fAbortBytes" fallback="中止序列（hex）">
                      <Input
                        value={form.abortBytes}
                        onChange={(e) => patch({ abortBytes: e.target.value })}
                        placeholder="0x03"
                        className="h-8 text-xs font-mono"
                      />
                      <FieldHelp>{tr("plugins.hAbortBytes", "")}</FieldHelp>
                    </Labeled>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={form.pipeStdin}
                        onCheckedChange={(v) => patch({ pipeStdin: v })}
                      />
                      <span className="text-xs">{tr("plugins.fPipeStdin", "")}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <Labeled labelKey="plugins.fAcpCommand" fallback="ACP 启动命令（每行一个参数）*">
                  <textarea
                    value={form.acpCommand}
                    onChange={(e) => patch({ acpCommand: e.target.value })}
                    placeholder={"npx\n-y\nmy-acp-agent"}
                    rows={3}
                    className="flex w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-mono"
                  />
                  <FieldHelp>{tr("plugins.hAcpCommand", "")}</FieldHelp>
                </Labeled>
              )}
            </div>
            )}

            {/* 配置与会话（仅智能体插件——工具插件 schema 禁止 config/session 段） */}
            {!isTool && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border border-border/50 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">{tr("plugins.configSection", "配置文件")}</p>
                  <Switch
                    checked={form.configEnabled}
                    onCheckedChange={(v) => patch({ configEnabled: v })}
                  />
                </div>
                {form.configEnabled && (
                  <>
                    <Labeled labelKey="plugins.fConfigPath" fallback="配置文件路径">
                      <Input
                        value={form.configPath}
                        onChange={(e) => patch({ configPath: e.target.value })}
                        placeholder="~/.xxx/settings.json"
                        className="h-8 text-xs font-mono"
                      />
                      <FieldHelp>{tr("plugins.hConfigPath", "")}</FieldHelp>
                    </Labeled>
                    <div className="flex items-center gap-2">
                      {(["json", "toml"] as const).map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          onClick={() => patch({ configFormat: fmt })}
                          className={cn(
                            "rounded-full border px-2.5 py-0.5 text-[10px] font-mono",
                            form.configFormat === fmt
                              ? "border-primary bg-primary/5 text-primary"
                              : "border-border/60 text-muted-foreground",
                          )}
                        >
                          {fmt}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <div className="rounded-md border border-border/50 p-3 space-y-3">
                <p className="text-xs font-medium">{tr("plugins.sessionSection", "会话存储")}</p>
                <div className="flex gap-2">
                  {(["hub", "none"] as const).map((store) => (
                    <button
                      key={store}
                      type="button"
                      onClick={() => patch({ sessionStore: store })}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-[10px]",
                        form.sessionStore === store
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border/60 text-muted-foreground",
                      )}
                    >
                      {store === "hub"
                        ? tr("plugins.storeHub", "hub（历史可回放）")
                        : tr("plugins.storeNone", "none（不持久化）")}
                    </button>
                  ))}
                </div>
                <FieldHelp>{tr("plugins.hStore", "")}</FieldHelp>
                <div className="flex flex-wrap gap-3 pt-1">
                  {(
                    [
                      ["abort", form.abort, (v: boolean) => patch({ abort: v }), tr("plugins.capAbort", "中止")],
                      ["image", form.imageInput, (v: boolean) => patch({ imageInput: v }), tr("plugins.capImage", "图片输入")],
                      ["stream", form.streamText, (v: boolean) => patch({ streamText: v }), tr("plugins.capStream", "流式文本")],
                    ] as const
                  ).map(([key, value, setter, label]) => (
                    <label key={key} className="flex items-center gap-1.5 text-xs">
                      <Switch checked={value} onCheckedChange={setter} />
                      {label}
                    </label>
                  ))}
                </div>
                <FieldHelp>{tr("plugins.hCaps", "")}</FieldHelp>
              </div>
            </div>
            )}

            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive break-all">
                {error}
              </div>
            )}
          </div>

          {/* 底部固定：仅 schema 徽标（取消/创建均已上移编辑区右上角）。 */}
          <DialogFooter className="shrink-0">
            <div className="flex items-center gap-2 mr-auto">
              <Badge variant="secondary" className="text-[10px] gap-1">
                <Bot className="h-3 w-3" />
                {tr("plugins.schemaVersion", "schema v1")}
              </Badge>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* MCP JSON 批量导入（需求19 第二轮）：多 server → 多插件。 */}
      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{tr("plugins.mcpBatchTitle", "批量导入 MCP 服务")}</DialogTitle>
            <DialogDescription>
              {tr("plugins.mcpBatchDesc", "粘贴包含多个 server 的 JSON（支持 mcpServers 包裹）；每个服务将创建一个独立 MCP 插件（插件 ID 由名称生成）。")}
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={batchJson}
            onChange={(e) => setBatchJson(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={'{\n  "mcpServers": {\n    "server-a": { "type": "stdio", "command": "npx", "args": [] },\n    "server-b": { "type": "http", "url": "https://mcp.example.com/mcp" }\n  }\n}'}
            className="flex w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-mono"
          />
          {batchParsed ? (
            batchParsed.ok ? (
              <p className="text-[11px] leading-snug text-muted-foreground">
                {tr("plugins.mcpBatchDetected", "识别到")} {batchParsed.servers.length} 个：{batchParsed.servers.map((x) => x.name).join("、")}
              </p>
            ) : (
              <p className="text-[11px] leading-snug text-destructive">{batchParsed.error}</p>
            )
          ) : (
            <p className="text-[11px] leading-snug text-muted-foreground">
              {tr("plugins.mcpBatchHint", "任一条目非法将整体报错，不会部分导入。")}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBatchOpen(false)}>
              {tr("common.cancel", "取消")}
            </Button>
            <Button size="sm" disabled={!batchParsed?.ok || importing} onClick={() => void handleBatchImport()}>
              {importing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {tr("plugins.mcpBatchAction", "导入")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
