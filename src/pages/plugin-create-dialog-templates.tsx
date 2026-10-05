/** v0.9.5 收口遗留②（god-component 第一刀）：插件创建对话框的静态数据层——
 * 模版预填（templates）与类型卡元数据（PLUGIN_TYPES），含 React 图标节点。
 * 自 plugin-create-dialog.tsx 零逻辑迁出（§12 拆分说明见该文件头）。
 * 历史：v0.8.1 需求6 模版 / v0.9.0 需求19 类型卡——注释随迁保留。 */
import { emptyForm, type FormState, type PluginType } from "./plugin-create-dialog-model";
import { Bot, Code2, Plus, Sparkles, Terminal, Blocks } from "lucide-react";
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

/** 模版 = 表单预填常量（用户显式选择的起点，非运行时 agent 分支）。
 * 形态取自三家内置 agent 的 CLI 接入方式，路径/命令均可再编辑。 */
export const templates: Template[] = [
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
      skillEntries: [
        {
          name: "",
          description: "提交前代码自查清单——逐文件检查错误处理与测试覆盖",
          body: "逐文件检查：\n1. 错误处理是否完整\n2. 新逻辑是否有测试覆盖\n3. 命名与既有风格一致",
        },
      ],
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

/** 类型卡元数据（v0.9.0 需求19，数据驱动——SKILL 类型后续零改布局扩展）。
 * formLabel = 实现形式（总控转发 / 独立插拔），是用户选型的关键依据。 */
export const PLUGIN_TYPES: Array<{
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
