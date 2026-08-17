import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Save } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { ProjectSettings } from "@/types";
import type { ProjectSettingsSurface } from "@/agents";
import { SectionHelp } from "@/components/config/section-help";
import { ActiveModelCard } from "@/components/config/active-model-card";

const MODE_OPTIONS = [
  { value: "default", labelKey: "config.modeDefault" },
  { value: "bypassPermissions", labelKey: "config.modeBypass" },
  { value: "plan", labelKey: "config.modePlan" },
];

interface ProjectSettingsFormProps {
  projectPath: string;
  /** 项目设置按 agent 读写（v0.7.0 需求一 adapter 路由；修复缺参报错）。 */
  agentId: string;
  /** 该 agent 的项目配置面（fields/scopes 驱动表单渲染，v0.7.4 适配）。 */
  surface: ProjectSettingsSurface;
  /** 该 agent 的真实模型候选项（jishu=models.json 扁平；claude/opencode=目录）。 */
  modelOptions?: { value: string; label: string; hint?: string }[];
}

export function ProjectSettingsForm({
  agentId,
  projectPath,
  surface,
  modelOptions,
}: ProjectSettingsFormProps) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<"shared" | "local">("shared");
  const [saving, setSaving] = useState(false);
  const [newAllow, setNewAllow] = useState("");
  const [newDeny, setNewDeny] = useState("");
  const [newEnvKey, setNewEnvKey] = useState("");

  const fields = surface.kind === "supported" ? (surface.fields ?? []) : [];
  const hasLocal = surface.kind === "supported" && surface.scopes.includes("local");
  const effectiveTarget = hasLocal ? target : "shared";
  const loadCmd = agentId
    ? effectiveTarget === "shared"
      ? "load_project_settings"
      : "load_project_settings_local"
    : "";
  const saveCmd =
    effectiveTarget === "shared" ? "save_project_settings" : "save_project_settings_local";

  const { data: loadedSettings, loading, error, refetch } = useInvoke<ProjectSettings>(
    loadCmd,
    agentId ? { agentId, projectPath } : undefined,
  );
  const [editedSettings, setEditedSettings] = useState<ProjectSettings | null>(null);

  const settings = editedSettings ?? loadedSettings ?? { permissions: null, hooks: null, env: null, model: null };
  const hasChanges = loadedSettings ? JSON.stringify(settings) !== JSON.stringify(loadedSettings) : false;

  const update = (patch: Partial<ProjectSettings>) => {
    setEditedSettings({ ...settings, ...patch });
  };

  const updatePermissions = (patch: Partial<ProjectSettings["permissions"]>) => {
    update({
      permissions: {
        defaultMode: settings.permissions?.defaultMode ?? null,
        allow: settings.permissions?.allow ?? null,
        deny: settings.permissions?.deny ?? null,
        ...patch,
      },
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await invokeCommand(saveCmd, { agentId, projectPath, settings });
      setEditedSettings(null);
      refetch();
    } catch (err) {
      console.error("Failed to save project settings:", err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-4 text-sm text-muted-foreground">{t("common.loading", "Loading...")}</div>;
  }

  if (error) {
    return <div className="p-4 text-sm text-destructive">{String(error)}</div>;
  }

  return (
    <div className="space-y-4">
      {/* File target toggle（仅支持 local 档的 agent 显示，如 claude；
          jishu/.pi 与 opencode/opencode.json 均为单档） */}
      {hasLocal && (
        <>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={target === "shared" ? "default" : "outline"}
              onClick={() => { setTarget("shared"); setEditedSettings(null); }}
            >
              {t("projectConfig.sharedSettings")}
            </Button>
            <Button
              size="sm"
              variant={target === "local" ? "default" : "outline"}
              onClick={() => { setTarget("local"); setEditedSettings(null); }}
            >
              {t("projectConfig.localSettings")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {target === "shared" ? t("projectConfig.sharedDesc") : t("projectConfig.localDesc")}
          </p>
        </>
      )}

      {/* Model（候选项按 agent 真实模型列表；与配置页/会话页同一选择体验） */}
      {fields.includes("model") && (
        <>
          <div>
            <span className="text-sm font-medium inline-flex items-center gap-1">{t("config.model")}<SectionHelp content={t("projectConfig.fieldMapModel")} /></span>
            <div className="mt-1">
              <ActiveModelCard
                current={
                  settings.model
                    ? {
                        value: settings.model,
                        label:
                          modelOptions?.find((o) => o.value === settings.model)?.label ??
                          settings.model,
                      }
                    : null
                }
                options={
                  modelOptions?.map((o) => ({
                    value: o.value,
                    label: o.label,
                    hint: o.hint,
                  })) ?? []
                }
                onSelect={(v) => update({ model: v || null })}
                allowCustom
                customPlaceholder={t("config.modelComboboxPlaceholder")}
                emptyHint={t("projectConfig.modelUnsetHint")}
              />
            </div>
          </div>
        </>
      )}

      {/* 上下文压缩（jishu：.pi/settings.json 的 compaction） */}
      {fields.includes("compaction") && (
        <div className="space-y-2">
          <span className="text-sm font-medium inline-flex items-center gap-1">
            {t("projectConfig.compaction")}
            <SectionHelp content={t("projectConfig.fieldMapCompaction")} />
          </span>
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
            <span className="text-sm">{t("projectConfig.compactionEnabled")}</span>
            <Switch
              checked={settings.compaction?.enabled !== false}
              onCheckedChange={(v) =>
                update({
                  compaction: {
                    enabled: v,
                    reserveTokens: settings.compaction?.reserveTokens ?? null,
                    keepRecentTokens: settings.compaction?.keepRecentTokens ?? null,
                  },
                })
              }
            />
          </div>
          <div className="grid grid-cols-2 items-start gap-3">
            <div className="space-y-1.5">
              <Label className="truncate text-xs">{t("projectConfig.compactionReserve")}</Label>
              <Input
                type="number"
                min="0"
                className="h-9 text-sm"
                value={settings.compaction?.reserveTokens ?? ""}
                onChange={(e) =>
                  update({
                    compaction: {
                      enabled: settings.compaction?.enabled ?? null,
                      reserveTokens: e.target.value ? Number(e.target.value) : null,
                      keepRecentTokens: settings.compaction?.keepRecentTokens ?? null,
                    },
                  })
                }
                placeholder="16384"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="truncate text-xs">{t("projectConfig.compactionKeepRecent")}</Label>
              <Input
                type="number"
                min="0"
                className="h-9 text-sm"
                value={settings.compaction?.keepRecentTokens ?? ""}
                onChange={(e) =>
                  update({
                    compaction: {
                      enabled: settings.compaction?.enabled ?? null,
                      reserveTokens: settings.compaction?.reserveTokens ?? null,
                      keepRecentTokens: e.target.value ? Number(e.target.value) : null,
                    },
                  })
                }
                placeholder="20000"
              />
            </div>
          </div>
        </div>
      )}

      {/* 默认思考档位（jishu：.pi/settings.json 的 defaultThinkingLevel） */}
      {fields.includes("thinking_level") && (
        <div>
          <span className="text-sm font-medium inline-flex items-center gap-1">
            {t("sessions.thinkingLevel.title")}
            <SectionHelp content={t("projectConfig.fieldMapThinkingLevel")} />
          </span>
          <select
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={settings.thinkingLevel ?? ""}
            onChange={(e) => update({ thinkingLevel: e.target.value || null })}
          >
            <option value="">{t("sessions.thinkingLevel.unset")}</option>
            {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((lvl) => (
              <option key={lvl} value={lvl}>
                {t(`sessions.thinkingLevel.${lvl}`)}
              </option>
            ))}
          </select>
        </div>
      )
      }
{fields.includes("permissions") && (
        <>      {/* Default Mode */}
      <div>
        <span className="text-sm font-medium inline-flex items-center gap-1">{t("projectConfig.defaultMode")}<SectionHelp content={t("projectConfig.fieldMapMode")} /></span>
        <select
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={settings.permissions?.defaultMode ?? ""}
          onChange={(e) => updatePermissions({ defaultMode: e.target.value || null })}
        >
          <option value="">{t("common.default")}</option>
          {MODE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
          ))}
        </select>
      </div>
        </>
      )}
{fields.includes("permissions") && (
        <>      {/* Allow List */}
      <div>
        <span className="text-sm font-medium inline-flex items-center gap-1">{t("projectConfig.allowList")}<SectionHelp content={t("projectConfig.fieldMapAllow")} /></span>
        <div className="mt-1 space-y-1">
          {(settings.permissions?.allow ?? []).map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-2 py-1 text-xs">{item}</code>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 shrink-0"
                onClick={() => {
                  const list = [...(settings.permissions?.allow ?? [])];
                  list.splice(i, 1);
                  updatePermissions({ allow: list.length ? list : null });
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Input
              className="h-8 text-xs"
              placeholder={t("projectConfig.patternPlaceholder")}
              value={newAllow}
              onChange={(e) => setNewAllow(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newAllow.trim()) {
                  updatePermissions({ allow: [...(settings.permissions?.allow ?? []), newAllow.trim()] });
                  setNewAllow("");
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              disabled={!newAllow.trim()}
              onClick={() => {
                if (newAllow.trim()) {
                  updatePermissions({ allow: [...(settings.permissions?.allow ?? []), newAllow.trim()] });
                  setNewAllow("");
                }
              }}
            >
              <Plus className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
        </>
      )}
{fields.includes("permissions") && (
        <>      {/* Deny List */}
      <div>
        <span className="text-sm font-medium inline-flex items-center gap-1">{t("projectConfig.denyList")}<SectionHelp content={t("projectConfig.fieldMapDeny")} /></span>
        <div className="mt-1 space-y-1">
          {(settings.permissions?.deny ?? []).map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-2 py-1 text-xs">{item}</code>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 shrink-0"
                onClick={() => {
                  const list = [...(settings.permissions?.deny ?? [])];
                  list.splice(i, 1);
                  updatePermissions({ deny: list.length ? list : null });
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Input
              className="h-8 text-xs"
              placeholder={t("projectConfig.patternPlaceholder")}
              value={newDeny}
              onChange={(e) => setNewDeny(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newDeny.trim()) {
                  updatePermissions({ deny: [...(settings.permissions?.deny ?? []), newDeny.trim()] });
                  setNewDeny("");
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              disabled={!newDeny.trim()}
              onClick={() => {
                if (newDeny.trim()) {
                  updatePermissions({ deny: [...(settings.permissions?.deny ?? []), newDeny.trim()] });
                  setNewDeny("");
                }
              }}
            >
              <Plus className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
        </>
      )}
{fields.includes("hooks") && (
        <>
      {/* Hooks (read-only view) */}
      <div>
        <span className="text-sm font-medium inline-flex items-center gap-1">{t("projectConfig.hooks")}<SectionHelp content={t("projectConfig.fieldMapHooks")} /></span>
        {settings.hooks && Object.keys(settings.hooks).length > 0 ? (
          <div className="mt-1 space-y-2">
            {Object.entries(settings.hooks).map(([event, entries]) => (
              <div key={event} className="rounded border p-2">
                <p className="text-xs font-medium text-muted-foreground">{event}</p>
                {entries.map((entry, i) => (
                  <div key={i} className="mt-1 space-y-1">
                    {entry.matcher && <p className="text-xs text-muted-foreground">{t("projectConfig.matcher")}: {entry.matcher}</p>}
                    {entry.hooks.map((hook, j) => (
                      <div key={j} className="flex items-start gap-2">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{hook.type}</code>
                        <code className="flex-1 break-all text-xs">{hook.command}</code>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-5 w-5 shrink-0"
                          onClick={() => {
                            const hooks = { ...settings.hooks! };
                            const list = [...(hooks[event] ?? [])];
                            list.splice(i, 1);
                            if (list.length === 0) {
                              delete hooks[event];
                            } else {
                              hooks[event] = list;
                            }
                            update({ hooks: Object.keys(hooks).length ? hooks : null });
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">{t("projectConfig.noHooks")}</p>
        )}
      </div>
        </>
      )}

{fields.includes("env") && (
        <>
      {/* Environment Variables */}
      <div>
        <span className="text-sm font-medium inline-flex items-center gap-1">{t("config.envVars")}<SectionHelp content={t("projectConfig.fieldMapEnv")} /></span>
        <div className="mt-1 space-y-1">
          {Object.entries(settings.env ?? {}).map(([key, val]) => (
            <div key={key} className="flex items-center gap-2">
              <code className="shrink-0 rounded bg-muted px-2 py-1 text-xs">{key}</code>
              <Input
                className="h-7 flex-1 text-xs"
                value={val}
                onChange={(e) => {
                  const env = { ...settings.env! };
                  env[key] = e.target.value;
                  update({ env });
                }}
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 shrink-0"
                onClick={() => {
                  const env = { ...settings.env! };
                  delete env[key];
                  update({ env: Object.keys(env).length ? env : null });
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Input
              className="h-8 text-xs"
              placeholder={t("config.key")}
              value={newEnvKey}
              onChange={(e) => setNewEnvKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newEnvKey.trim()) {
                  update({ env: { ...settings.env, [newEnvKey.trim()]: "" } });
                  setNewEnvKey("");
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              disabled={!newEnvKey.trim()}
              onClick={() => {
                if (newEnvKey.trim()) {
                  update({ env: { ...settings.env, [newEnvKey.trim()]: "" } });
                  setNewEnvKey("");
                }
              }}
            >
              <Plus className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
        </>
      )}

      {/* Save button */}
      <Button className="w-full" onClick={handleSave} disabled={!hasChanges || saving}>
        <Save className="mr-2 h-4 w-4" />
        {saving ? t("common.saving") : t("common.save")}
      </Button>
    </div>
  );
}
