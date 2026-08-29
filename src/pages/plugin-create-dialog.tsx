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
import { Bot, Code2, Loader2, Plus, Sparkles, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";

/** v0.8.1 需求6：插件创建可视化界面——模版快速创建（claude/codex/opencode
 * 形态预填）+ 分组表单 + 字段级能力说明。提交走 plugin_create（后端全量
 * schema 校验 + serde 生成 TOML，前端零拼 TOML）。 */

interface CreateProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  /** 编辑模式（v0.8.1 GUI 反馈：新增插件无法编辑）：传入插件 id 时对话框
   * 预填其 manifest，id 锁定，提交走 plugin_update 覆盖写回。 */
  editPluginId?: string | null;
}

/** 表单模型（提交时转换为 manifest JSON wire 结构）。 */
interface FormState {
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
  /** v0.8.1 需求7：工具插件（kind = "tool"）的 [tool] 段字段。 */
  kind: "agent" | "tool";
  toolDescription: string;
  toolUsage: string;
  toolExample: string;
  toolNotes: string;
}

interface Template {
  key: string;
  nameKey: string;
  nameFallback: string;
  icon: React.ReactNode;
  /** TOML 原文（「如何配置」的活示例，创建后即此形态）。 */
  toml: string;
  form: FormState;
  /** 该模版创建的插件类型（agent / tool）。 */
  tplKind: "agent" | "tool";
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
  kind: "agent" as const,
  toolDescription: "",
  toolUsage: "",
  toolExample: "",
  toolNotes: "",
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
    tplKind: "tool",
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
      kind: "tool",
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
    key: "tool-dingtalk",
    nameKey: "plugins.tplToolDingtalk",
    nameFallback: "钉钉 CLI 工具",
    icon: <Bot className="h-4 w-4" />,
    tplKind: "tool",
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
      kind: "tool",
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

/** 表单 → manifest JSON（wire 结构与后端 AgentManifestFile 对齐；空值省略）。 */
function buildManifest(form: FormState): Record<string, unknown> {
  if (form.kind === "tool") {
    const tool: Record<string, unknown> = {
      schema: 1,
      kind: "tool",
      info: {
        id: form.id.trim(),
        display_name: form.displayName.trim(),
        ...(form.icon.trim() ? { icon: form.icon.trim() } : {}),
        ...(form.installHint.trim() ? { install_hint: form.installHint.trim() } : {}),
      },
      tool: {
        description: form.toolDescription.trim(),
        usage: form.toolUsage.trim(),
        ...(form.toolExample.trim() ? { example: form.toolExample.trim() } : {}),
        ...(form.toolNotes.trim() ? { notes: form.toolNotes.trim() } : {}),
      },
    };
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

/** manifest JSON（plugin_get 返回）→ 表单状态（buildManifest 的逆映射）。 */
function parseManifest(json: Record<string, unknown>): FormState {
  const info = (json.info ?? {}) as Record<string, unknown>;
  const probe = json.probe as Record<string, unknown> | undefined;
  const transport = (json.transport ?? {}) as Record<string, unknown>;
  const config = json.config as Record<string, unknown> | undefined;
  const session = (json.session ?? {}) as Record<string, unknown>;
  const caps = (json.capabilities ?? {}) as Record<string, unknown>;
  const tool = (json.tool ?? {}) as Record<string, unknown>;
  return {
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
    kind: json.kind === "tool" ? "tool" : "agent",
    toolDescription: String(tool.description ?? ""),
    toolUsage: String(tool.usage ?? ""),
    toolExample: String(tool.example ?? ""),
    toolNotes: String(tool.notes ?? ""),
  };
}

export function PluginCreateDialog({ open, onOpenChange, onCreated, editPluginId }: CreateProps) {
  const { t } = useTranslation();
  const { alert: alertDialog, dialogNode } = useConfirmDialog();
  const [templateKey, setTemplateKey] = useState("blank");
  const [form, setForm] = useState<FormState>(templates[0].form);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = !!editPluginId;

  // 编辑模式：打开时拉取现有 manifest 预填（失败则表单保持原样并提示）。
  useEffect(() => {
    if (!open || !editPluginId) return;
    setError(null);
    invokeCommand<Record<string, unknown>>("plugin_get", { pluginId: editPluginId })
      .then((json) => {
        if (json) setForm(parseManifest(json));
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
    setForm({ ...tp.form });
    setError(null);
  };

  const patch = (partial: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...partial }));

  const isTool = form.kind === "tool";
  const canSubmit =
    form.id.trim().length > 0 &&
    form.displayName.trim().length > 0 &&
    (isTool
      ? form.toolDescription.trim().length > 0 && form.toolUsage.trim().length > 0
      : form.transportKind === "cli"
        ? form.chatCommand.trim().length > 0
        : form.acpCommand.trim().length > 0);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const created = isEdit
        ? await invokeCommand<{ id: string; path: string }>("plugin_update", {
            pluginId: editPluginId,
            manifest: buildManifest(form),
          })
        : await invokeCommand<{ id: string; path: string }>("plugin_create", {
            manifest: buildManifest(form),
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
        <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEdit ? tr("plugins.editTitle", "编辑插件") : tr("plugins.createTitle", "新建插件")}</DialogTitle>
            <DialogDescription>{tr("plugins.createDesc", "")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            {/* 模版选择（按插件类型分组；v0.8.1 需求7：智能体 / 工具两类） */}
            <div>
              <p className="text-xs font-medium mb-2">{tr("plugins.tplSection", "从模版开始")}</p>
              {(["agent", "tool"] as const).map((group) => (
                <div key={group} className="mb-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
                    {group === "agent"
                      ? tr("plugins.tplGroupAgent", "智能体插件")
                      : tr("plugins.tplGroupTool", "工具插件")}
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {templates
                      .filter((tp) => tp.tplKind === group)
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
                  </div>
                </div>
              ))}
              <details className="mt-2 group">
                <summary className="text-[11px] text-muted-foreground cursor-pointer select-none">
                  {tr("plugins.viewToml", "查看模版 TOML（manifest 格式参考）")}
                </summary>
                <pre className="mt-2 rounded-md bg-muted/60 p-3 text-[10px] leading-relaxed overflow-x-auto">
                  {template.toml}
                </pre>
              </details>
            </div>

            {/* 基本信息 */}
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

            {/* 工具插件能力声明（v0.8.1 需求7：kind = "tool"） */}
            {isTool && (
              <div className="rounded-md border border-border/50 p-3 space-y-3">
                <p className="text-xs font-medium">{tr("plugins.toolSection", "工具能力声明")}</p>
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
                      className="h-8 text-xs"
                    />
                  </Labeled>
                </div>
              </div>
            )}

            {/* 探测 */}
            {!isTool && (<>
            <div className="rounded-md border border-border/50 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">{tr("plugins.probeSection", "安装探测")}</p>
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

            {/* 传输 */}
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

            {/* 配置与会话 */}
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

            </>)}

            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive break-all">
                {error}
              </div>
            )}
          </div>

          <DialogFooter>
            <div className="flex items-center gap-2 mr-auto">
              <Badge variant="secondary" className="text-[10px] gap-1">
                <Bot className="h-3 w-3" />
                {tr("plugins.schemaVersion", "schema v1")}
              </Badge>
            </div>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {tr("common.cancel", "取消")}
            </Button>
            <Button size="sm" disabled={!canSubmit || submitting} onClick={handleSubmit}>
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isEdit ? tr("plugins.saveAction", "保存修改") : tr("plugins.createAction", "创建")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
