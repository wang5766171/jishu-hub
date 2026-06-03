import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAgent } from "@/agents";
import { invokeCommand } from "@/hooks/use-invoke";
import { ClipboardList, Download, Eye, History, Plus, RefreshCw, Send, Sparkles, Trash2, Wand2, X, XCircle } from "lucide-react";

type TaskKind = "plan" | "run";
type AssignmentMode = "manual" | "auto_suggest" | "auto_apply";

interface RoleDraft {
  roleId: string;
  roleName: string;
  agentId: string;
  responsibilities: string;
  acceptance: string;
  canEditFiles: boolean;
  canRunCommands: boolean;
  canReceiveRework: boolean;
}

interface RunSummary {
  run_id: string;
  task_id: string;
  status: string;
  started_at: number;
  finished_at?: number | null;
  title?: string | null;
}

interface RunRecord {
  run_id: string;
  spec: {
    message: string;
    project_path?: string | null;
    assignment_mode?: AssignmentMode | null;
    parent_run_id?: string | null;
    roles?: Array<{
      role_id: string;
      role_name: string;
      agent_id?: string | null;
      responsibilities?: string[];
      acceptance?: string[];
    }>;
  };
  plan: Array<{
    step_id: string;
    title: string;
    depends_on: string[];
    kind: {
      dispatch?: { role_id: string; prompt: string; project: string };
      shell?: { command: string; cwd: string };
      read?: { path: string };
      write?: { path: string; requires_approval: boolean };
      reflect?: { question: string };
      verify?: { check: Record<string, unknown> };
    } | Record<string, unknown>;
  }>;
  result: { status: string; error?: string | null; summary?: string | null; cost_usd?: number | null };
  timeline?: TaskTimelineEvent[];
  rework_routes?: RoleContractRoute[];
  rework_items?: ReworkItem[];
  children?: RunSummary[];
}

interface TaskTimelineEvent {
  event_id: string;
  kind: string;
  title: string;
  detail?: unknown;
  step_id?: string | null;
  role_id?: string | null;
  agent_id?: string | null;
  at?: number | null;
}

interface RoleContractRoute {
  from_role_id: string;
  from_role_name: string;
  from_agent_id: string;
  target_role_id: string;
  target_role_name: string;
  target_agent_id: string;
  reason: string;
}

interface ReworkItem {
  item_id: string;
  source_run_id: string;
  source_step_id: string;
  source_role_id: string;
  responsible_role: string;
  target_role_id?: string | null;
  target_agent_id?: string | null;
  target_run_id?: string | null;
  reason: string;
  evidence: string;
  suggested_action: string;
  severity?: string | null;
}

interface TaskPlanRole {
  role_id: string;
  role_name: string;
  responsibilities: string[];
  acceptance: string[];
  can_edit_files: boolean;
  can_run_commands: boolean;
  can_receive_rework: boolean;
}

interface TaskPlanSkill {
  id: string;
  name: string;
  description: string;
  path?: string | null;
  installed: boolean;
  builtin: boolean;
  installable: boolean;
  valid: boolean;
  error?: string | null;
  content_bytes: number;
  roles: TaskPlanRole[];
}

function roleDraftFromPlanRole(role: TaskPlanRole): RoleDraft {
  return {
    roleId: role.role_id,
    roleName: role.role_name,
    agentId: "",
    responsibilities: role.responsibilities.join("\n"),
    acceptance: role.acceptance.join("\n"),
    canEditFiles: role.can_edit_files,
    canRunCommands: role.can_run_commands,
    canReceiveRework: role.can_receive_rework,
  };
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "complete") return "default";
  if (status === "aborted") return "outline";
  if (status === "error") return "destructive";
  return "secondary";
}

function formatTime(value?: number | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

export function TasksPage({
  initialProjectPath,
  onClose,
}: {
  initialProjectPath?: string | null;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const { agents } = useAgent();
  const [taskKind, setTaskKind] = useState<TaskKind>("plan");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [taskPlanSkills, setTaskPlanSkills] = useState<TaskPlanSkill[]>([]);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [projectPath, setProjectPath] = useState(initialProjectPath ?? "");
  const [roles, setRoles] = useState<RoleDraft[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [generatingRoles, setGeneratingRoles] = useState(false);
  const [executingPlan, setExecutingPlan] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ runId: string; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialProjectPath && !projectPath) {
      setProjectPath(initialProjectPath);
    }
  }, [initialProjectPath, projectPath]);

  const agentOptions = useMemo(
    () => agents.map((agent) => ({ id: agent.id, label: agent.display_name || agent.id })),
    [agents]
  );
  const selectedTemplate = taskPlanSkills.find((template) => template.id === selectedTemplateId) ?? taskPlanSkills[0] ?? null;

  useEffect(() => {
    if (!taskPlanSkills.length) return;
    if (!selectedTemplateId || !taskPlanSkills.some((skill) => skill.id === selectedTemplateId)) {
      const preferred = taskPlanSkills.find((skill) => skill.installed) ?? taskPlanSkills[0];
      setSelectedTemplateId(preferred.id);
    }
  }, [selectedTemplateId, taskPlanSkills]);

  const translateStatus = (status: string) => t(`tasks.status.${status}`, { defaultValue: status });

  const refreshTaskPlanSkills = async () => {
    setLoadingSkills(true);
    setError(null);
    try {
      const skills = await invokeCommand<TaskPlanSkill[]>("task_plan_skill_list");
      setTaskPlanSkills(skills);
      return skills;
    } catch (err) {
      setError(String(err));
      return [];
    } finally {
      setLoadingSkills(false);
    }
  };

  const installTaskPlanSkill = async () => {
    if (!selectedTemplate || !selectedTemplate.installable) return;
    setInstallingSkillId(selectedTemplate.id);
    setError(null);
    try {
      await invokeCommand<TaskPlanSkill>("task_plan_skill_install", { skillId: selectedTemplate.id });
      await refreshTaskPlanSkills();
    } catch (err) {
      setError(String(err));
    } finally {
      setInstallingSkillId(null);
    }
  };

  const generateRolesFromTemplate = async () => {
    if (!selectedTemplate || !message.trim() || !selectedTemplate.installed || !selectedTemplate.valid) return;
    setGeneratingRoles(true);
    setError(null);
    try {
      const generatedRoles = await invokeCommand<TaskPlanRole[]>("task_plan_generate_roles", {
        skillId: selectedTemplate.id,
        message: message.trim(),
      });
      setRoles(generatedRoles.map(roleDraftFromPlanRole));
      setSelectedRun(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setGeneratingRoles(false);
    }
  };

  const addPresetRole = (role: TaskPlanRole) => {
    setRoles((current) => [...current, roleDraftFromPlanRole(role)]);
  };

  const refreshRuns = async () => {
    setLoading(true);
    setError(null);
    try {
      const nextRuns = await invokeCommand<RunSummary[]>("run_list");
      setRuns(nextRuns);
      return nextRuns;
    } catch (err) {
      setError(String(err));
      return [];
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshRuns().catch(console.error);
    refreshTaskPlanSkills().catch(console.error);
  }, []);

  // Close context menu on any click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [contextMenu]);

  const loadRun = async (runId: string) => {
    setError(null);
    try {
      const record = await invokeCommand<RunRecord>("run_get", { runId });
      setSelectedRun(record);
    } catch (err) {
      setError(String(err));
    }
  };

  const submitTask = async () => {
    if (!message.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const now = Date.now();
      const taskId = `hub_${now}`;
      const spec = {
        task_id: taskId,
        kind: taskKind,
        message: message.trim(),
        project_path: projectPath.trim() || null,
        roles: roles
          .filter((role) => role.roleName.trim() && role.agentId.trim())
          .map((role) => ({
            role_id: role.roleId.trim() || role.roleName.trim().toLowerCase().replace(/\s+/g, "_"),
            role_name: role.roleName.trim(),
            agent_id: role.agentId.trim() || null,
            responsibilities: splitLines(role.responsibilities),
            acceptance: splitLines(role.acceptance),
            can_edit_files: role.canEditFiles,
            can_run_commands: role.canRunCommands,
            can_receive_rework: role.canReceiveRework,
          })),
        assignment_mode: "manual",
        policy: "default",
        parent_run_id: null,
        epic_id: null,
        depth: 0,
        created_at: now,
        deadline_ms: null,
        labels: { source: "hub", title: title.trim() || taskId, template: selectedTemplateId },
      };
      const submitted = await invokeCommand<{ run_id: string }>("task_submit", { spec });
      await refreshRuns();
      await loadRun(submitted.run_id);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const cancelRun = async (runId: string) => {
    setError(null);
    try {
      await invokeCommand("run_cancel", { runId });
      await refreshRuns();
      await loadRun(runId);
    } catch (err) {
      setError(String(err));
    }
  };

  const executePlan = async (runId: string) => {
    setExecutingPlan(true);
    setError(null);
    try {
      await invokeCommand("run_execute_plan", { runId });
      await refreshRuns();
      await loadRun(runId);
    } catch (err) {
      setError(String(err));
    } finally {
      setExecutingPlan(false);
    }
  };

  const deleteRun = async (runId: string) => {
    if (!window.confirm(t("tasks.confirmDelete"))) return;
    setError(null);
    try {
      await invokeCommand("run_delete", { runId });
      setSelectedRun(null);
      await refreshRuns();
    } catch (err) {
      setError(String(err));
    }
  };

  const updateRole = (index: number, patch: Partial<RoleDraft>) => {
    setRoles((current) => current.map((role, i) => (i === index ? { ...role, ...patch } : role)));
  };

  const addRole = () => {
    setRoles((current) => [
      ...current,
      {
        roleId: `role_${current.length + 1}`,
        roleName: "",
        agentId: "",
        responsibilities: "",
        acceptance: "",
        canEditFiles: false,
        canRunCommands: false,
        canReceiveRework: true,
      },
    ]);
  };

  return (
    <div className="h-full space-y-5 overflow-auto p-6 pb-20">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t("tasks.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("tasks.description")}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={refreshRuns} title={t("tasks.refreshRuns")}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          {onClose && (
            <Button variant="ghost" size="icon" onClick={onClose} title={t("tasks.close")}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">{t("tasks.hubTask")}</h3>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("tasks.taskTitle")}</Label>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("tasks.taskTitlePlaceholder")}
                className="h-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("tasks.projectPath")}</Label>
              <Input
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
                placeholder={t("tasks.projectPathPlaceholder")}
                className="h-8"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("tasks.taskGoal")}</Label>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={t("tasks.taskGoalPlaceholder")}
              className="h-24 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="rounded-md border bg-background/50 p-3">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold">{t("tasks.templateSection")}</h4>
                <p className="text-xs text-muted-foreground">{t("tasks.templateHint")}</p>
              </div>
              <Badge variant="secondary">{t("tasks.rolesGenerated", { count: roles.length })}</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto]">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("tasks.templateLabel")}</Label>
                <select
                  value={selectedTemplateId}
                  onChange={(event) => setSelectedTemplateId(event.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  disabled={loadingSkills || taskPlanSkills.length === 0}
                >
                  {taskPlanSkills.length === 0 && <option value="">{t("tasks.noTaskPlanSkills")}</option>}
                  {taskPlanSkills.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                      {template.installed ? "" : ` (${t("tasks.notInstalled")})`}
                    </option>
                  ))}
                </select>
              </div>
              {selectedTemplate?.installable && (
                <Button
                  variant="outline"
                  onClick={installTaskPlanSkill}
                  disabled={installingSkillId === selectedTemplate.id}
                  className="mt-5 whitespace-nowrap gap-2"
                >
                  <Download className="h-4 w-4" />
                  {installingSkillId === selectedTemplate.id
                    ? t("tasks.installingSkill")
                    : selectedTemplate.installed && !selectedTemplate.valid
                      ? t("tasks.repairSkill")
                      : t("tasks.installSkill")}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={generateRolesFromTemplate}
                disabled={!message.trim() || !selectedTemplate?.installed || !selectedTemplate?.valid || generatingRoles}
                className="mt-5 whitespace-nowrap gap-2"
                title={
                  !message.trim()
                    ? t("tasks.templateRequiresGoal")
                    : !selectedTemplate?.installed
                      ? t("tasks.installSkillFirst")
                      : !selectedTemplate?.valid
                        ? t("tasks.invalidSkill")
                      : t("tasks.generateBreakdown")
                }
              >
                <Wand2 className="h-4 w-4" />
                {generatingRoles ? t("tasks.generatingBreakdown") : t("tasks.generateBreakdown")}
              </Button>
            </div>
            {selectedTemplate && (
              <div className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{selectedTemplate.name}</span>
                  <Badge variant={selectedTemplate.installed && selectedTemplate.valid ? "default" : "outline"}>
                    {selectedTemplate.installed
                      ? selectedTemplate.valid
                        ? t("tasks.installed")
                        : t("tasks.invalidSkill")
                      : t("tasks.notInstalled")}
                  </Badge>
                  {selectedTemplate.builtin && <Badge variant="secondary">{t("tasks.builtinSkill")}</Badge>}
                  <Badge variant="outline">{t("tasks.skillBytes", { count: selectedTemplate.content_bytes })}</Badge>
                </div>
                <div className="mt-1">{selectedTemplate.description || t("tasks.noSkillDescription")}</div>
                {selectedTemplate.error && (
                  <div className="mt-1 text-destructive">{selectedTemplate.error}</div>
                )}
                {selectedTemplate.path && <div className="mt-1 truncate">{selectedTemplate.path}</div>}
                <div className="mt-1">{t("tasks.agentAssignmentHint")}</div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex rounded-md border bg-muted/40 p-1">
              {(["plan", "run"] as TaskKind[]).map((kind) => (
                <button
                  key={kind}
                  onClick={() => setTaskKind(kind)}
                  className={`h-7 rounded px-3 text-xs font-medium transition-colors ${
                    taskKind === kind ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                  }`}
                >
                  {t(`tasks.kind.${kind}`)}
                </button>
              ))}
            </div>
            <Button onClick={submitTask} disabled={!message.trim() || submitting} className="gap-2">
              <Send className="h-4 w-4" />
              {submitting ? t("tasks.submitting") : t("tasks.submit")}
            </Button>
          </div>
        </div>

        <div className="space-y-3 rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t("tasks.runs")}</h3>
            <Badge variant="secondary">{runs.length}</Badge>
          </div>
          <div className="space-y-2">
            {runs.length === 0 ? (
              <div className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">
                {loading ? t("tasks.loadingRuns") : t("tasks.noRuns")}
              </div>
            ) : (
              runs.slice(0, 12).map((run) => (
                <button
                  key={run.run_id}
                  onClick={() => loadRun(run.run_id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ runId: run.run_id, x: e.clientX, y: e.clientY });
                  }}
                  className={`w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent/40 ${
                    selectedRun?.run_id === run.run_id
                      ? "bg-accent/60 border-primary"
                      : "bg-background/60"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{run.title || run.task_id}</span>
                    <Badge variant={statusVariant(run.status)}>{translateStatus(run.status)}</Badge>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{run.run_id}</div>
                </button>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("tasks.roleAssignments")}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value=""
              onChange={(event) => {
                const role = selectedTemplate?.roles.find((item) => item.role_id === event.target.value);
                if (role) addPresetRole(role);
              }}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              disabled={!selectedTemplate?.roles.length}
              title={t("tasks.addPresetRole")}
            >
              <option value="">{t("tasks.addPresetRole")}</option>
              {(selectedTemplate?.roles ?? []).map((role) => (
                <option key={role.role_id} value={role.role_id}>
                  {role.role_name}
                </option>
              ))}
            </select>
            <Button variant="outline" size="sm" onClick={addRole}>
              <Plus className="h-4 w-4" />
              {t("tasks.addRole")}
            </Button>
          </div>
        </div>
        {roles.length === 0 ? (
          <div className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">
            {t("tasks.noRoles")}
          </div>
        ) : (
          <div className="space-y-3">
            {roles.map((role, index) => (
              <div key={`${role.roleId}-${index}`} className="grid gap-3 rounded-md border bg-background/60 p-3 lg:grid-cols-[140px_150px_minmax(0,1fr)_minmax(0,1fr)_40px]">
                <div className="space-y-1">
                  <Label className="text-xs">{t("tasks.role")}</Label>
                  <Input value={role.roleName} onChange={(event) => updateRole(index, { roleName: event.target.value })} className="h-8" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t("tasks.agent")}</Label>
                  <select
                    value={role.agentId}
                    onChange={(event) => updateRole(index, { agentId: event.target.value })}
                    className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                  >
                    <option value="">{t("tasks.selectAgent")}</option>
                    {agentOptions.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t("tasks.responsibilities")}</Label>
                  <textarea
                    value={role.responsibilities}
                    onChange={(event) => updateRole(index, { responsibilities: event.target.value })}
                    className="h-16 w-full resize-none rounded-md border border-input bg-transparent px-2 py-1 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t("tasks.acceptance")}</Label>
                  <textarea
                    value={role.acceptance}
                    onChange={(event) => updateRole(index, { acceptance: event.target.value })}
                    className="h-16 w-full resize-none rounded-md border border-input bg-transparent px-2 py-1 text-xs"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setRoles((current) => current.filter((_, i) => i !== index))}
                  title={t("tasks.removeRole")}
                  className="mt-5"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Context menu for run rows */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[180px] rounded-md border bg-popover p-1 shadow-md"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              setContextMenu(null);
              loadRun(contextMenu.runId);
            }}
          >
            <Eye className="h-4 w-4" />
            {t("tasks.viewDetails")}
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              setContextMenu(null);
              executePlan(contextMenu.runId);
            }}
            disabled={executingPlan}
          >
            <Send className="h-4 w-4" />
            {t("tasks.executePlan")}
          </button>
          <div className="my-1 h-px bg-border" />
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
            onClick={() => {
              setContextMenu(null);
              deleteRun(contextMenu.runId);
            }}
          >
            <Trash2 className="h-4 w-4" />
            {t("tasks.delete")}
          </button>
        </div>
      )}

      {/* Right-side detail drawer */}
      {selectedRun && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30 backdrop-blur-sm" onClick={() => setSelectedRun(null)}>
          <div
            className="flex h-full w-full max-w-2xl flex-col overflow-hidden border-l bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-base font-semibold">{selectedRun.spec.message}</h3>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{selectedRun.run_id}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={statusVariant(selectedRun.result.status)}>{translateStatus(selectedRun.result.status)}</Badge>
                <Button variant="ghost" size="icon" onClick={() => setSelectedRun(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-2 border-b bg-muted/30 px-5 py-2">
              {selectedRun.result.status === "complete" && selectedRun.plan.length > 0 && (
                <Button size="sm" onClick={() => executePlan(selectedRun.run_id)} disabled={executingPlan}>
                  <Send className="h-4 w-4" />
                  {executingPlan ? t("tasks.executingPlan") : t("tasks.executePlan")}
                </Button>
              )}
              {!["complete", "error"].includes(selectedRun.result.status) && (
                <Button variant="outline" size="sm" onClick={() => cancelRun(selectedRun.run_id)}>
                  <XCircle className="h-4 w-4" />
                  {t("tasks.cancel")}
                </Button>
              )}
              <div className="flex-1" />
              <Button variant="ghost" size="sm" onClick={() => deleteRun(selectedRun.run_id)} className="text-destructive">
                <Trash2 className="h-4 w-4" />
                {t("tasks.delete")}
              </Button>
            </div>

            <div className="flex-1 space-y-4 overflow-auto p-5">
              {/* AI Summary */}
              <section className="rounded-lg border bg-gradient-to-br from-violet-500/5 to-blue-500/5 p-4">
                <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5" />
                  {t("tasks.aiSummary")}
                </h4>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
                  {selectedRun.result.summary || t("tasks.noSummary")}
                </p>
              </section>

              {selectedRun.spec.parent_run_id && (
                <div className="rounded-md border border-info/40 bg-info/5 px-3 py-2 text-xs">
                  {t("tasks.parentRun", { runId: selectedRun.spec.parent_run_id })}
                </div>
              )}

              {(selectedRun.children?.length ?? 0) > 0 && (
                <section>
                  <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{t("tasks.childRuns")}</h4>
                  <div className="space-y-1">
                    {selectedRun.children!.map((child) => (
                      <button
                        key={child.run_id}
                        onClick={() => loadRun(child.run_id)}
                        className="w-full rounded border bg-background/60 px-2 py-1 text-left text-xs transition-colors hover:bg-accent/40"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">{child.title || child.task_id}</span>
                          <Badge variant={statusVariant(child.status)} className="text-[10px]">
                            {translateStatus(child.status)}
                          </Badge>
                        </div>
                        <span className="text-muted-foreground">{child.run_id}</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {(selectedRun.rework_items?.length ?? 0) > 0 && (
                <section>
                  <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{t("tasks.reworkItems")}</h4>
                  <div className="space-y-2">
                    {selectedRun.rework_items!.map((item) => (
                      <div key={item.item_id} className="rounded border bg-background/60 px-3 py-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{item.responsible_role}</span>
                          {item.severity && (
                            <Badge variant={item.severity === "critical" || item.severity === "high" ? "destructive" : "secondary"} className="text-[10px]">
                              {item.severity}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 text-muted-foreground">{item.reason}</p>
                        {item.target_run_id && (
                          <p className="mt-1 text-info">{t("tasks.reworkDispatchedTo", { runId: item.target_run_id })}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <section>
                  <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{t("tasks.assignedRoles")}</h4>
                  <div className="space-y-2">
                    {(selectedRun.spec.roles ?? []).length === 0 ? (
                      <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                        {t("tasks.noAssignedRoles")}
                      </div>
                    ) : (
                      (selectedRun.spec.roles ?? []).map((role) => (
                        <div key={role.role_id} className="rounded-md border bg-background/60 px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">{role.role_name}</span>
                            <Badge variant="secondary">{role.agent_id || t("tasks.unassigned")}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{role.responsibilities?.join("; ")}</p>
                        </div>
                      ))
                    )}
                  </div>
                </section>
                <section>
                  <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{t("tasks.planSteps")}</h4>
                  <div className="space-y-2">
                    {selectedRun.plan.length === 0 ? (
                      <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                        {t("tasks.noPlanSteps")}
                      </div>
                    ) : (
                      selectedRun.plan.map((step, index) => (
                        <div key={step.step_id} className="rounded-md border bg-background/60 px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">{t("tasks.stepOf", { index: index + 1 })}</span>
                            <span className="text-xs text-muted-foreground">{step.step_id}</span>
                          </div>
                          <p className="mt-1 text-xs">
                            {(step.kind as { dispatch?: { prompt?: string }; reflect?: { question?: string }; shell?: { command?: string } }).dispatch?.prompt
                              || (step.kind as { reflect?: { question?: string } }).reflect?.question
                              || (step.kind as { shell?: { command?: string } }).shell?.command
                              || JSON.stringify(step.kind)}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              </div>

              <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
                    <History className="h-3.5 w-3.5" />
                    {t("tasks.timeline")}
                  </h4>
                  <Badge variant="secondary">{selectedRun.timeline?.length ?? 0}</Badge>
                </div>
                {(selectedRun.timeline ?? []).length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                    {t("tasks.noTimeline")}
                  </div>
                ) : (
                  <ol className="space-y-2 border-l-2 border-muted pl-4">
                    {(selectedRun.timeline ?? []).map((event) => (
                      <li key={event.event_id} className="relative">
                        <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-muted-foreground" />
                        <div className="rounded-md bg-background/60 px-3 py-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-sm font-medium">{event.title}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                {event.step_id && <span>{event.step_id}</span>}
                                {event.role_id && <span>{event.role_id}</span>}
                                {event.agent_id && <span>{event.agent_id}</span>}
                                {event.at && <span>{formatTime(event.at)}</span>}
                              </div>
                            </div>
                            <Badge variant="outline" className="text-[10px]">{event.kind}</Badge>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <div className="text-xs text-muted-foreground">
                {t("tasks.startedAt", { time: formatTime(runs.find((run) => run.run_id === selectedRun.run_id)?.started_at) })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
