/** v0.9.5 收口遗留②（god-component 第一刀）：插件创建对话框的模型层——
 * 纯函数 + 类型 + 表单缺省（零 React 依赖，构建/解析/编辑往返双向映射）。
 * 自 plugin-create-dialog.tsx 零逻辑迁出（§12 拆分说明见该文件头）；
 * 契约测试：plugin-create-mcp.test.ts。
 * 历史：v0.8.1 需求6 表单 / v0.9.0 需求1 二期 MCP 双模式三传输 /
 * 需求19 类型优先 / 需求20 skill 条目——各函数头注释随迁保留。 */
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
  /** v0.9.0 需求20 + v0.9.1 需求10：[skill]/[[skill]] 段——多 skill 条目
   *（name 留空 = 单数形态，仅一条且无名时以插件 id 命名；多条必须命名）。 */
  skillEntries: Array<{ name: string; description: string; body: string }>;
  /** v0.9.0 需求19 第八轮：[panel] 段（声明式自定义插件的核心声明面）。 */
  panelTitle: string;
  panelItems: Array<{ label: string; command: string }>;
  /** v0.9.0 需求20 第四轮：agent 的 [skills].dir（skill 根目录声明）。 */
  skillsDir: string;
}

export const emptyForm: FormState = {
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
  skillEntries: [],
  panelTitle: "",
  panelItems: [],
  skillsDir: "",
};

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
export function parseMcpHeaders(text: string): Record<string, string> | undefined {
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
export function parseEnvLines(text: string): Record<string, string> | undefined {
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
    // v0.9.0 需求20 + v0.9.1 需求10：skill 段——完整条目才产出（description/
    // body 非空）；单条且 name 留空 → [skill] 表（单数形态，skill 名 = 插件
    // id）；否则 → [[skill]] 数组（多 skill，部署名 <pid>__<name>）。
    {
      const entries = form.skillEntries
        .map((e) => ({
          name: e.name.trim(),
          description: e.description.trim(),
          body: e.body.trim(),
        }))
        .filter((e) => e.description && e.body);
      if (entries.length === 1 && !entries[0].name) {
        tool.skill = {
          description: entries[0].description,
          body: entries[0].body,
        };
      } else if (entries.length > 0) {
        tool.skill = entries;
      }
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
  // v0.9.0 需求20 第四轮：[skills].dir——声明后 hub 把启用插件的 SKILL.md
  // 分发到该目录（<dir>/<skill名>/SKILL.md），实现自建智能体的 skill 接入。
  if (form.skillsDir.trim()) {
    manifest.skills = { dir: form.skillsDir.trim() };
  }
  return manifest;
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
  const skillsSec = json.skills as Record<string, unknown> | undefined;
  const panelSec = json.panel as Record<string, unknown> | undefined;
  // v0.9.1 需求10（GUI/CLI 能力一致）：[skill] 单/双形态归一为条目——
  // 表（单 skill，无名）与 [[skill]] 数组（多 skill，带名）均可编辑。
  const skillEntries: Array<{ name: string; description: string; body: string }> =
    Array.isArray(json.skill)
      ? (json.skill as Array<Record<string, unknown>>).map((e) => ({
          name: String(e.name ?? ""),
          description: String(e.description ?? ""),
          body: String(e.body ?? ""),
        }))
      : json.skill && typeof json.skill === "object"
        ? [
            {
              name: "",
              description: String((json.skill as Record<string, unknown>).description ?? ""),
              body: String((json.skill as Record<string, unknown>).body ?? ""),
            },
          ]
        : [];
  const hasSkill = skillEntries.length > 0;
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
          : hasSkill
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
    skillEntries,
    skillsDir: String(skillsSec?.dir ?? ""),
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
