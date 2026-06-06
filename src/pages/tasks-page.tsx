import { TaskRunsList, statusVariant } from "@/components/tasks/TaskRunsList";
import { ParallelGantt } from '@/components/tasks/ParallelGantt';
import { useEffect, useMemo, useState } from "react";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAgent } from "@/agents";
import { invokeCommand } from "@/hooks/use-invoke";
import { openFloatingSession } from "@/lib/floating-window";
import { AlertTriangle, ClipboardList, Download, Eye, History, Pencil, Plus, RefreshCw, Save, Send, Sparkles, Trash2, Wand2, X, XCircle } from "lucide-react";

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

export interface RunSummary {
  run_id: string;
  task_id: string;
  status: string;
  started_at: number;
  finished_at?: number | null;
  title?: string | null;
}

export interface RunRecord {
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
  plan: SerializedPlanStep[];
  plan_document?: PlanDocument | null;
  result: {
    status: string;
    error?: string | null;
    summary?: string | null;
    cost_usd?: number | null;
    started_at: number;
    finished_at?: number | null;
    steps: StepOutcome[];
  };
  timeline?: TaskTimelineEvent[];
  rework_routes?: RoleContractRoute[];
  rework_items?: ReworkItem[];
  children?: RunSummary[];
}

interface SerializedPlanStep {
  step_id: string;
  depends_on?: string[];
  timeout_ms?: number | null;
  title?: string;
  kind: Record<string, unknown>;
}

interface PlanDocument {
  schema_version: number;
  run_id: string;
  skill_id?: string | null;
  revision: number;
  status: string;
  steps: SerializedPlanStep[];
  validation: {
    valid: boolean;
    errors: Array<{ code: string; message: string; step_id?: string | null }>;
    warnings: Array<{ code: string; message: string; step_id?: string | null }>;
  };
  updated_at: number;
}

type EditablePlanStepType = "dispatch" | "reflect";

interface PlanStepDraft {
  stepId: string;
  type: EditablePlanStepType;
  roleId: string;
  prompt: string;
  project: string;
  dependsOn: string;
  timeoutMs: string;
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

export interface StepOutcome {
  step_id: string;
  role_id: string;
  agent_id: string;
  agent_display_name?: string | null;
  status: "running" | "complete" | "failed" | "skipped" | "awaiting_approval";
  output?: unknown;
  session_id?: string | null;
  started_at: number;
  finished_at: number;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
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

interface PlanTraceItem {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  isError?: boolean;
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



function formatTime(value?: number | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function unwrapStepKind(kind: unknown): { type: string; data: Record<string, unknown> } {
  const record = asRecord(kind);
  const taggedType = textValue(record.type);
  if (taggedType) {
    return { type: taggedType, data: record };
  }

  const nestedType = Object.keys(record).find((key) => key !== "title") ?? "unknown";
  return { type: nestedType, data: asRecord(record[nestedType]) };
}

function planStepPrompt(step: SerializedPlanStep): string {
  const { type, data } = unwrapStepKind(step.kind);
  if (type === "dispatch") return textValue(data.prompt);
  if (type === "reflect") return textValue(data.question) || textValue(data.prompt);
  if (type === "shell") return textValue(data.command);
  if (type === "read") return textValue(data.path);
  if (type === "write") return textValue(data.path);
  return JSON.stringify(step.kind);
}

function planStepRoleId(step: SerializedPlanStep): string {
  const { type, data } = unwrapStepKind(step.kind);
  return type === "dispatch" ? textValue(data.role_id) : "";
}

function planStepProject(step: SerializedPlanStep): string {
  const { type, data } = unwrapStepKind(step.kind);
  if (type === "dispatch") return textValue(data.project);
  return "";
}

function planStepToDraft(step: SerializedPlanStep, fallbackProject: string): PlanStepDraft {
  const { type, data } = unwrapStepKind(step.kind);
  const editableType: EditablePlanStepType = type === "reflect" ? "reflect" : "dispatch";
  return {
    stepId: step.step_id,
    type: editableType,
    roleId: editableType === "dispatch" ? textValue(data.role_id) : "",
    prompt: editableType === "reflect"
      ? textValue(data.question) || textValue(data.prompt)
      : textValue(data.prompt),
    project: editableType === "dispatch" ? textValue(data.project, fallbackProject) : "",
    dependsOn: (step.depends_on ?? []).join(", "),
    timeoutMs: step.timeout_ms == null ? "" : String(step.timeout_ms),
  };
}

function draftToPlanStep(draft: PlanStepDraft, fallbackProject: string): SerializedPlanStep {
  const timeout = draft.timeoutMs.trim() ? Number(draft.timeoutMs.trim()) : null;
  const base = {
    step_id: draft.stepId.trim(),
    depends_on: splitLines(draft.dependsOn),
    timeout_ms: Number.isFinite(timeout) ? timeout : null,
  };

  if (draft.type === "reflect") {
    return {
      ...base,
      kind: {
        type: "reflect",
        question: draft.prompt.trim(),
      },
    };
  }

  return {
    ...base,
    kind: {
      type: "dispatch",
      role_id: draft.roleId.trim(),
      prompt: draft.prompt.trim(),
      project: draft.project.trim() || fallbackProject || ".",
      session: null,
    },
  };
}

function validatePlanDrafts(drafts: PlanStepDraft[], t: (key: string, opts?: Record<string, unknown>) => string): string | null {
  if (drafts.length === 0) return t("tasks.validation.needOneStep");
  const ids = new Set<string>();
  for (const [index, draft] of drafts.entries()) {
    const idx = String(index + 1);
    if (!draft.stepId.trim()) return t("tasks.validation.stepMissingId", { index: idx });
    if (ids.has(draft.stepId.trim())) return t("tasks.validation.stepDuplicateId", { index: idx });
    ids.add(draft.stepId.trim());
    if (!draft.prompt.trim()) return t("tasks.validation.stepMissingPrompt", { index: idx });
    if (draft.type === "dispatch" && !draft.roleId.trim()) return t("tasks.validation.stepMissingRole", { index: idx });
    if (draft.timeoutMs.trim() && !Number.isFinite(Number(draft.timeoutMs.trim()))) {
      return t("tasks.validation.stepTimeoutNaN", { index: idx });
    }
  }
  return null;
}

function traceEventToItem(event: unknown, index: number): PlanTraceItem {
  const record = asRecord(event);
  const kind = textValue(record.kind, "unknown");
  if (kind === "text_delta") {
    return {
      id: `trace_text_${index}`,
      kind,
      title: "jishu agent",
      detail: textValue(record.delta),
    };
  }
  if (kind === "tool_use_start") {
    return {
      id: `trace_tool_start_${index}`,
      kind,
      title: `调用工具 ${textValue(record.tool, "tool")}`,
      detail: JSON.stringify(record.input ?? {}, null, 2),
    };
  }
  if (kind === "tool_use_result") {
    const output = asRecord(record.output);
    return {
      id: `trace_tool_result_${index}`,
      kind,
      title: `工具返回 ${textValue(output.tool, "tool")}`,
      detail: textValue(output.result) || JSON.stringify(record.output ?? {}, null, 2),
      isError: Boolean(record.is_error),
    };
  }
  if (kind === "task_step") {
    return {
      id: `trace_task_${index}`,
      kind,
      title: textValue(record.title, "任务事件"),
      detail: record.detail ? JSON.stringify(record.detail, null, 2) : undefined,
    };
  }
  return {
    id: `trace_${index}`,
    kind,
    title: kind,
    detail: JSON.stringify(event),
  };
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
  const [timelineExpanded, setTimelineExpanded] = useState(true);
  const [timelineView, setTimelineView] = useState<"list" | "parallel">("list");
  const [timelineFilter, setTimelineFilter] = useState<string>("all");
  const [planStatus, setPlanStatus] = useState<string>("");
  const [planEditing, setPlanEditing] = useState(false);
  const [planDrafts, setPlanDrafts] = useState<PlanStepDraft[]>([]);
  const [savingPlan, setSavingPlan] = useState(false);
  const [planEditError, setPlanEditError] = useState<string | null>(null);
  const [planTraceOffset, setPlanTraceOffset] = useState(0);
  const [planTraceItems, setPlanTraceItems] = useState<PlanTraceItem[]>([]);
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
  const defaultGeneratedAgentId = agentOptions.length === 1 ? agentOptions[0].id : "";
  const selectedRunProject = selectedRun?.spec.project_path?.trim() || projectPath.trim() || ".";
  const roleAssignmentError =
    selectedTemplate?.installed && selectedTemplate.valid
      ? roles.length === 0
        ? t("tasks.generateRolesBeforeSubmit")
        : roles.some((role) => !role.roleName.trim() || !role.agentId.trim())
          ? t("tasks.assignRoleAgentsFirst")
          : null
      : selectedTemplate && !selectedTemplate.installed
        ? t("tasks.installSkillFirst")
        : selectedTemplate && !selectedTemplate.valid
          ? t("tasks.invalidSkill")
          : null;
  const submitDisabled = !message.trim() || submitting || Boolean(roleAssignmentError);

  useEffect(() => {
    if (!taskPlanSkills.length) return;
    if (!selectedTemplateId || !taskPlanSkills.some((skill) => skill.id === selectedTemplateId)) {
      const preferred = taskPlanSkills.find((skill) => skill.installed) ?? taskPlanSkills[0];
      setSelectedTemplateId(preferred.id);
    }
  }, [selectedTemplateId, taskPlanSkills]);

  const translateStatus = (status: string) => t(`tasks.status.${status}`, { defaultValue: status });
  const translatePlanDocumentStatus = (status?: string | null) => {
    if (!status) return t("tasks.planStatus.none");
    return t(`tasks.planStatus.${status}`, { defaultValue: status });
  };

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
      setRoles(
        generatedRoles.map((role) => ({
          ...roleDraftFromPlanRole(role),
          agentId: defaultGeneratedAgentId,
        }))
      );
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

  // Poll active runs every 2s
  useEffect(() => {
    const hasActive = runs.some((r) =>
      ["running", "queued", "awaiting_rework", "awaiting_approval"].includes(r.status)
    );
    if (!hasActive) return;
    const interval = setInterval(() => {
      refreshRuns().catch(console.error);
      if (selectedRun && ["running", "queued"].includes(selectedRun.result.status)) {
        loadRun(selectedRun.run_id).catch(console.error);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [runs, selectedRun?.run_id, selectedRun?.result.status]);

  const loadRun = async (runId: string) => {
    setError(null);
    try {
      const record = await invokeCommand<RunRecord>("run_get", { runId });
      setSelectedRun(record);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    if (!selectedRun) {
      setPlanEditing(false);
      setPlanDrafts([]);
      setPlanTraceOffset(0);
      setPlanTraceItems([]);
      setPlanStatus("");
      setPlanEditError(null);
      return;
    }
    setPlanTraceOffset(0);
    setPlanTraceItems([]);
    setPlanEditError(null);
    if (!planEditing) {
      setPlanDrafts(selectedRun.plan.map((step) => planStepToDraft(step, selectedRunProject)));
    }
  }, [selectedRun?.run_id, selectedRun?.plan.length, selectedRun?.plan_document?.revision]);

  const submitTask = async () => {
    if (!message.trim()) return;
    if (roleAssignmentError) {
      setError(roleAssignmentError);
      return;
    }
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
    if (planEditing) {
      setPlanEditError(t("tasks.planEdit.saveOrCancelFirst"));
      return;
    }
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

  const regenerateSummary = async (runId: string) => {
    const lang = i18n.language?.startsWith("en") ? "en" : "zh";
    setError(null);
    try {
      await invokeCommand("run_summarize", { runId, language: lang });
      await loadRun(runId);
    } catch (err) {
      setError(String(err));
    }
  };

  const [pendingApprovals, setPendingApprovals] = useState<Record<string, {
    request_id: string;
    kind: string;
    question: string;
    options: string[];
    context?: string;
  }>>({});

  const [replyText, setReplyText] = useState<Record<string, string>>({});

  // Poll for pending approvals on the currently-selected run
  useEffect(() => {
    if (!selectedRun) return;
    const runId = selectedRun.run_id;
    const fetchApprovals = async () => {
      const updates: typeof pendingApprovals = { ...pendingApprovals };
      let changed = false;
      for (const step of selectedRun.result.steps ?? []) {
        try {
          const approval = await invokeCommand<{
            request_id: string; kind: string; question: string;
            options: string[]; context?: string;
          } | null>("run_get_approval", { runId, stepId: step.step_id });
          const key = `${runId}::${step.step_id}`;
          if (approval) {
            updates[key] = approval;
            changed = true;
          } else if (updates[key]) {
            // Was previously pending, now resolved
            delete updates[key];
            changed = true;
          }
        } catch {
          // ignore
        }
      }
      if (changed) setPendingApprovals(updates);
    };
    fetchApprovals();
    const interval = setInterval(fetchApprovals, 2000);
    return () => clearInterval(interval);
  }, [selectedRun?.run_id, selectedRun?.result.steps]);

  const sendReply = async (stepId: string, message: string) => {
    if (!selectedRun || !message.trim()) return;
    try {
      await invokeCommand("run_send_message", {
        runId: selectedRun.run_id,
        stepId,
        message,
      });
      setReplyText((prev) => ({ ...prev, [`${selectedRun.run_id}::${stepId}`]: "" }));
      // Refresh the run to pick up new step outcome
      await loadRun(selectedRun.run_id);
    } catch (err) {
      setError(String(err));
    }
  };

  const beginPlanEdit = () => {
    if (!selectedRun) return;
    setPlanDrafts(selectedRun.plan.map((step) => planStepToDraft(step, selectedRunProject)));
    setPlanEditError(null);
    setPlanEditing(true);
  };

  const updatePlanDraft = (index: number, patch: Partial<PlanStepDraft>) => {
    setPlanDrafts((current) =>
      current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft))
    );
  };

  const addPlanDraftStep = () => {
    const rolesForRun = selectedRun?.spec.roles ?? [];
    setPlanDrafts((current) => [
      ...current,
      {
        stepId: `step_${current.length + 1}`,
        type: "dispatch",
        roleId: rolesForRun[0]?.role_id ?? "default",
        prompt: "",
        project: selectedRunProject,
        dependsOn: current.length > 0 ? current[current.length - 1].stepId : "",
        timeoutMs: "",
      },
    ]);
    setPlanEditing(true);
  };

  const savePlanDraft = async () => {
    if (!selectedRun) return;
    const localError = validatePlanDrafts(planDrafts, t);
    if (localError) {
      setPlanEditError(localError);
      return;
    }

    setSavingPlan(true);
    setPlanEditError(null);
    setError(null);
    try {
      const steps = planDrafts.map((draft) => draftToPlanStep(draft, selectedRunProject));
      await invokeCommand<PlanDocument>("plan_update_steps", {
        runId: selectedRun.run_id,
        steps,
      });
      setPlanEditing(false);
      await loadRun(selectedRun.run_id);
      await refreshRuns();
    } catch (err) {
      setPlanEditError(String(err));
    } finally {
      setSavingPlan(false);
    }
  };

  // Poll plan_state.json when the run is in Plan mode (status=Running,
  // plan_state.status ∈ {pending, generating, plan_ready, ...}).
  // This is how the HUB "sees" the LLM streaming — the LLM events
  // land in plan_state.json via the PlanAgent's persistence step.
  useEffect(() => {
    if (!selectedRun) return;
    if (selectedRun.result.status !== "running") return;
    // Cheap heuristic: if the task is Plan kind and there are no
    // step outcomes yet, treat it as plan generation in progress.
    const isPlan = selectedRun.plan.length === 0 &&
      (selectedRun.result as { summary?: string | null }).summary === undefined;
    if (!isPlan) return;
    const runId = selectedRun.run_id;
    let cancelled = false;
    const fetchState = async () => {
      try {
        const state = await invokeCommand<{
          status: string;
          plan: unknown;
        } | null>("plan_get_state", { runId });
        if (cancelled) return;
        if (state) {
          setPlanStatus(state.status);
          if (state.plan) {
            // Plan just got committed — reload the run to pick it up
            loadRun(runId).catch(console.error);
          }
        }
      } catch (e) {
        // ignore
      }
    };
    fetchState();
    const interval = setInterval(fetchState, 1500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedRun?.run_id, selectedRun?.result.status]);

  useEffect(() => {
    if (!selectedRun) return;
    if (selectedRun.result.status !== "running" || selectedRun.plan.length > 0) return;
    const runId = selectedRun.run_id;
    let cancelled = false;
    const fetchTrace = async () => {
      try {
        const response = await invokeCommand<{ events: unknown[]; offset: number }>("trace_tail", {
          runId,
          byteOffset: planTraceOffset,
        });
        if (cancelled) return;
        setPlanTraceOffset(response.offset);
        if (response.events.length > 0) {
          setPlanTraceItems((current) => [
            ...current,
            ...response.events.map((event, index) => traceEventToItem(event, current.length + index)),
          ].slice(-60));
        }
      } catch {
        // Best-effort live trace; run polling still refreshes the final plan.
      }
    };
    fetchTrace();
    const interval = setInterval(fetchTrace, 1500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedRun?.run_id, selectedRun?.result.status, selectedRun?.plan.length, planTraceOffset]);

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
            <Button
              onClick={submitTask}
              disabled={submitDisabled}
              className="gap-2"
              title={!message.trim() ? t("tasks.templateRequiresGoal") : roleAssignmentError ?? t("tasks.submit")}
            >
              <Send className="h-4 w-4" />
              {submitting ? t("tasks.submitting") : t("tasks.submit")}
            </Button>
          </div>
        </div>

        <TaskRunsList
          runs={runs}
          loading={loading}
          selectedRun={selectedRun}
          loadRun={loadRun}
          onContextMenu={(e, runId) => {
            e.preventDefault();
            setContextMenu({ runId, x: e.clientX, y: e.clientY });
          }}
        />
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
                <Button size="sm" onClick={() => executePlan(selectedRun.run_id)} disabled={executingPlan || planEditing}>
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
              <section className="rounded-lg border bg-gradient-to-br from-violet-500/10 to-blue-500/10 p-4">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
                    <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                    {t("tasks.aiSummary")}
                  </h4>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => regenerateSummary(selectedRun.run_id)}
                    title={t("tasks.regenerateSummary")}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {selectedRun.result.summary ? (
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
                    {selectedRun.result.summary}
                  </p>
                ) : (
                  <p className="mt-2 text-sm italic text-muted-foreground">
                    {t("tasks.noSummary")}
                  </p>
                )}
              </section>

              {/* Error detail — shown ABOVE AI summary when run failed */}
              {selectedRun.result.status === "error" && selectedRun.result.error && (
                <section className="rounded-lg border-2 border-red-500/60 bg-red-500/5 p-4">
                  <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-red-700 dark:text-red-300">
                    ⚠ {t("tasks.errorDetail")}
                  </h4>
                  <pre className="mt-2 whitespace-pre-wrap break-all text-xs text-red-700 dark:text-red-300 font-mono">
                    {selectedRun.result.error}
                  </pre>
                  <p className="mt-2 text-[10px] text-muted-foreground">
                    {t("tasks.errorDetailHint")}
                  </p>
                </section>
              )}

              {/* Running indicator */}
              {["running", "queued"].includes(selectedRun.result.status) && (
                <div className="rounded-md border border-blue-500/40 bg-blue-500/5 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
                  ⏳ {t("tasks.running")}
                </div>
              )}

              {/* Plan Generation View — visible when run is in Plan mode
                  and still running. Shows live status from the
                  PlanAgent (LLM streaming + tool calls). */}
              {selectedRun.result.status === "running" &&
                selectedRun.plan.length === 0 && (
                <section className="rounded-lg border-2 border-violet-500/40 bg-violet-500/5 p-4">
                  <h4 className="flex items-center gap-2 text-sm font-semibold text-violet-700 dark:text-violet-300">
                    <Sparkles className="h-4 w-4" />
                    {t("tasks.planGenerating")}
                  </h4>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {planStatus
                      ? translatePlanDocumentStatus(planStatus)
                      : t("tasks.awaitingLLM", { defaultValue: "..." })}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        invokeCommand("plan_cancel", { runId: selectedRun.run_id })
                          .then(() => {
                            loadRun(selectedRun.run_id).catch(console.error);
                          })
                          .catch(console.error);
                      }}
                    >
                      {t("tasks.cancelPlan")}
                    </Button>
                  </div>
                  <div className="mt-3 space-y-2">
                    {planTraceItems.length === 0 ? (
                      <div className="rounded-md border border-dashed bg-background/50 p-3 text-xs text-muted-foreground">
                        {t("tasks.planGen.waitingAgent")}
                      </div>
                    ) : (
                      planTraceItems.map((item) => (
                        <div
                          key={item.id}
                          className={`rounded-md border bg-background/70 px-3 py-2 text-xs ${
                            item.isError ? "border-destructive/50 text-destructive" : ""
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{item.title}</span>
                            <Badge variant="outline" className="text-[10px]">{item.kind}</Badge>
                          </div>
                          {item.detail && (
                            <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                              {item.detail}
                            </pre>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </section>
              )}

              {/* Pending approvals — one card per agent question */}
              {(selectedRun.result.steps ?? []).map((step) => {
                const key = `${selectedRun.run_id}::${step.step_id}`;
                const approval = pendingApprovals[key];
                if (!approval) return null;
                return (
                  <section
                    key={key}
                    id={`approval-${step.step_id}`}
                    className="rounded-lg border-2 border-amber-500/60 bg-amber-500/5 p-4 shadow-sm transition-all"
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300">
                        ❓
                      </span>
                      <h4 className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                        {t("tasks.agentAsking")} · {step.agent_display_name || step.agent_id}
                      </h4>
                    </div>
                    {approval.context && (
                      <p className="mb-2 whitespace-pre-wrap text-xs text-muted-foreground">
                        {approval.context}
                      </p>
                    )}
                    <p className="mb-3 text-sm font-medium">{approval.question}</p>

                    {/* Quick-reply options */}
                    {approval.options.length > 0 && (
                      <div className="mb-3 flex flex-wrap gap-2">
                        {approval.options.map((opt, i) => (
                          <Button
                            key={i}
                            variant="outline"
                            size="sm"
                            onClick={() => sendReply(step.step_id, opt)}
                            className="text-xs"
                          >
                            {opt}
                          </Button>
                        ))}
                      </div>
                    )}

                    {/* Custom reply */}
                    <div className="flex gap-2">
                      <Input
                        value={replyText[key] ?? ""}
                        onChange={(e) =>
                          setReplyText((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                        placeholder={t("tasks.replyPlaceholder")}
                        className="h-8 text-xs"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            sendReply(step.step_id, replyText[key] ?? "");
                          }
                        }}
                      />
                      <Button
                        size="sm"
                        onClick={() => sendReply(step.step_id, replyText[key] ?? "")}
                        disabled={!(replyText[key] ?? "").trim()}
                      >
                        {t("tasks.sendReply")}
                      </Button>
                    </div>
                    {approval.options.length === 0 && (
                      <p className="mt-2 text-[10px] text-muted-foreground">
                        {t("tasks.noOptions")}
                      </p>
                    )}
                  </section>
                );
              })}

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
                <section className="md:col-span-2">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-xs font-semibold uppercase text-muted-foreground">{t("tasks.planSteps")}</h4>
                      {selectedRun.plan_document && (
                        <>
                          <Badge variant="outline" className="text-[10px]">
                            rev {selectedRun.plan_document.revision}
                          </Badge>
                          <Badge variant={selectedRun.plan_document.validation.valid ? "secondary" : "destructive"} className="text-[10px]">
                            {translatePlanDocumentStatus(selectedRun.plan_document.status)}
                          </Badge>
                          {selectedRun.plan_document.skill_id && (
                            <Badge variant="secondary" className="text-[10px]">
                              {selectedRun.plan_document.skill_id}
                            </Badge>
                          )}
                        </>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {planEditing ? (
                        <>
                          <Button variant="outline" size="sm" onClick={() => {
                            setPlanEditing(false);
                            setPlanDrafts(selectedRun.plan.map((step) => planStepToDraft(step, selectedRunProject)));
                            setPlanEditError(null);
                          }}>
                            <X className="h-4 w-4" />
                            {t("tasks.planEdit.cancelEdit")}
                          </Button>
                          <Button size="sm" onClick={savePlanDraft} disabled={savingPlan}>
                            <Save className="h-4 w-4" />
                            {savingPlan ? t("tasks.planEdit.saving") : t("tasks.planEdit.savePlan")}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button variant="outline" size="sm" onClick={beginPlanEdit} disabled={selectedRun.plan.length === 0}>
                            <Pencil className="h-4 w-4" />
                            {t("tasks.planEdit.editFinal")}
                          </Button>
                          <Button variant="outline" size="sm" onClick={addPlanDraftStep}>
                            <Plus className="h-4 w-4" />
                            {t("tasks.planEdit.addStep")}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {planEditError && (
                    <div className="mb-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{planEditError}</span>
                    </div>
                  )}

                  {(selectedRun.plan_document?.validation.errors.length ?? 0) > 0 && (
                    <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                      {selectedRun.plan_document!.validation.errors.map((issue) => (
                        <div key={`${issue.step_id ?? "plan"}-${issue.code}`}>
                          {issue.step_id ? `${issue.step_id}: ` : ""}{issue.message}
                        </div>
                      ))}
                    </div>
                  )}

                  {planEditing ? (
                    <div className="space-y-3">
                      {planDrafts.map((draft, index) => (
                        <div key={`${draft.stepId}-${index}`} className="rounded-md border bg-background/60 p-3">
                          <div className="grid gap-2 md:grid-cols-[120px_110px_minmax(0,1fr)_120px]">
                            <div className="space-y-1">
                              <Label className="text-xs">step_id</Label>
                              <Input
                                value={draft.stepId}
                                onChange={(event) => updatePlanDraft(index, { stepId: event.target.value })}
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">类型</Label>
                              <select
                                value={draft.type}
                                onChange={(event) => updatePlanDraft(index, { type: event.target.value as EditablePlanStepType })}
                                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
                              >
                                <option value="dispatch">dispatch</option>
                                <option value="reflect">reflect</option>
                              </select>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">角色</Label>
                              <select
                                value={draft.roleId}
                                onChange={(event) => updatePlanDraft(index, { roleId: event.target.value })}
                                disabled={draft.type !== "dispatch"}
                                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs disabled:opacity-50"
                              >
                                {(selectedRun.spec.roles ?? []).length === 0 && <option value="default">default</option>}
                                {(selectedRun.spec.roles ?? []).map((role) => (
                                  <option key={role.role_id} value={role.role_id}>
                                    {role.role_name} ({role.agent_id || "unassigned"})
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">超时 ms</Label>
                              <Input
                                value={draft.timeoutMs}
                                onChange={(event) => updatePlanDraft(index, { timeoutMs: event.target.value })}
                                className="h-8 text-xs"
                              />
                            </div>
                          </div>
                          <div className="mt-2 grid gap-2 md:grid-cols-2">
                            <div className="space-y-1">
                              <Label className="text-xs">依赖步骤</Label>
                              <Input
                                value={draft.dependsOn}
                                onChange={(event) => updatePlanDraft(index, { dependsOn: event.target.value })}
                                placeholder="scope, design"
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">项目路径</Label>
                              <Input
                                value={draft.project}
                                onChange={(event) => updatePlanDraft(index, { project: event.target.value })}
                                disabled={draft.type !== "dispatch"}
                                className="h-8 text-xs disabled:opacity-50"
                              />
                            </div>
                          </div>
                          <div className="mt-2 space-y-1">
                            <Label className="text-xs">执行说明</Label>
                            <textarea
                              value={draft.prompt}
                              onChange={(event) => updatePlanDraft(index, { prompt: event.target.value })}
                              className="h-20 w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-xs"
                            />
                          </div>
                          <div className="mt-2 flex justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setPlanDrafts((current) => current.filter((_, i) => i !== index))}
                              className="text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                              {t("tasks.planEdit.removeStep")}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {selectedRun.plan.length === 0 ? (
                        <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                          {t("tasks.noPlanSteps")}
                        </div>
                      ) : (
                        selectedRun.plan.map((step, index) => {
                          const type = unwrapStepKind(step.kind).type;
                          const roleId = planStepRoleId(step);
                          const role = (selectedRun.spec.roles ?? []).find((item) => item.role_id === roleId);
                          return (
                            <div key={step.step_id} className="rounded-md border bg-background/60 px-3 py-2">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-sm font-medium">{t("tasks.stepOf", { index: index + 1 })}</span>
                                  <Badge variant="outline" className="text-[10px]">{type}</Badge>
                                  {roleId && (
                                    <Badge variant="secondary" className="text-[10px]">
                                      {role?.role_name ?? roleId}
                                    </Badge>
                                  )}
                                  {role?.agent_id && (
                                    <Badge variant="outline" className="text-[10px]">{role.agent_id}</Badge>
                                  )}
                                </div>
                                <span className="text-xs text-muted-foreground">{step.step_id}</span>
                              </div>
                              <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">
                                {planStepPrompt(step)}
                              </p>
                              <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                                {(step.depends_on ?? []).length > 0 && <span>depends: {(step.depends_on ?? []).join(", ")}</span>}
                                {planStepProject(step) && <span>project: {planStepProject(step)}</span>}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </section>
              </div>

              <section>
                <button
                  onClick={() => setTimelineExpanded((v) => !v)}
                  className="mb-2 flex w-full items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs font-semibold uppercase text-muted-foreground transition-colors hover:bg-muted/50"
                >
                  <span className="flex items-center gap-1.5">
                    <History className="h-3.5 w-3.5" />
                    {t("tasks.timeline")}
                    <Badge variant="secondary" className="ml-1 text-[10px]">
                      {selectedRun.result.steps?.length ?? 0}
                    </Badge>
                  </span>
                  <span className="text-xs normal-case text-muted-foreground">
                    {timelineExpanded ? "▼" : "▶"}
                  </span>
                </button>
                {timelineExpanded && (
                  <>
                    {/* View switcher + role filter */}
                    <div className="mb-2 flex flex-wrap items-center gap-1">
                      <div className="inline-flex rounded-md border bg-muted/30 p-0.5 text-xs">
                        <button
                          onClick={() => setTimelineView("list")}
                          className={`rounded px-2 py-0.5 ${timelineView === "list" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                        >
                          {t("tasks.listView")}
                        </button>
                        <button
                          onClick={() => setTimelineView("parallel")}
                          className={`rounded px-2 py-0.5 ${timelineView === "parallel" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                        >
                          {t("tasks.parallelView")}
                        </button>
                      </div>
                      {timelineView === "list" && (() => {
                        const roles = new Set<string>();
                        (selectedRun.result.steps ?? []).forEach((s) => roles.add(s.role_id || "default"));
                        return (
                          <div className="inline-flex flex-wrap rounded-md border bg-muted/30 p-0.5 text-xs">
                            <button
                              onClick={() => setTimelineFilter("all")}
                              className={`rounded px-2 py-0.5 ${timelineFilter === "all" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                            >
                              {t("tasks.all")} ({selectedRun.result.steps?.length ?? 0})
                            </button>
                            {Array.from(roles).map((r) => {
                              const count = (selectedRun.result.steps ?? []).filter((s) => (s.role_id || "default") === r).length;
                              return (
                                <button
                                  key={r}
                                  onClick={() => setTimelineFilter(r)}
                                  className={`rounded px-2 py-0.5 ${timelineFilter === r ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                                >
                                  {r} ({count})
                                </button>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>

                    {timelineView === "list" ? (
                      /* List view: filtered step outcomes with meaningful labels */
                      (selectedRun.result.steps ?? []).filter((s) =>
                        timelineFilter === "all" || (s.role_id || "default") === timelineFilter
                      ).length === 0 ? (
                        <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                          {t("tasks.noTimeline")}
                        </div>
                      ) : (
                        <ol className="space-y-2 border-l-2 border-muted pl-4">
                          {(selectedRun.result.steps ?? [])
                            .filter((s) => timelineFilter === "all" || (s.role_id || "default") === timelineFilter)
                            .map((step) => {
                              // Map role_id → human-readable action label
                              const actionKey = step.role_id || "default";
                              const actionLabel = t(`tasks.actions.${actionKey}`) !== `tasks.actions.${actionKey}`
                                ? t(`tasks.actions.${actionKey}`)
                                : t("tasks.actions.default");
                              const isRunning = step.status === "running";
                              const isAwaiting = step.status === "awaiting_approval";
                              const isComplete = step.status === "complete";
                              const isFailed = step.status === "failed";
                              const durationSec = isRunning
                                ? Math.round((Date.now() - step.started_at) / 1000)
                                : Math.max(0, Math.round((step.finished_at - step.started_at) / 1000));

                              return (
                                <li key={step.step_id} className="relative">
                                  <span
                    className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ${
                                      isComplete ? "bg-green-500" :
                                      isFailed ? "bg-red-500" :
                                      isAwaiting ? "bg-amber-500" :
                                      isRunning ? "bg-blue-500 animate-pulse" :
                                      "bg-muted-foreground"
                                    }`}
                                  />
                                  <div className="rounded-md bg-background/60 px-3 py-2">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <div className="min-w-0 flex-1">
                                        <div className="text-sm font-medium">
                                          {step.agent_display_name || step.agent_id} · {actionLabel}
                                        </div>
                                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                          {isRunning && (
                                            <span className="font-medium text-blue-600 dark:text-blue-400">
                                              ⏳ {t("tasks.runningFor", { seconds: durationSec })}
                                            </span>
                                          )}
                                          {isAwaiting && (
                                            <span className="font-medium text-amber-600 dark:text-amber-400">
                                              ⚠ {t("tasks.pending")}
                                            </span>
                                          )}
                                          {isComplete && (
                                            <span>✓ {t("tasks.ago", { seconds: durationSec })}</span>
                                          )}
                                          {isFailed && <span>✗ {t("tasks.status.failed")}</span>}
                                          {step.usage && (step.usage.input_tokens > 0 || step.usage.output_tokens > 0) && (
                                            <span className="text-[10px]">
                                              {step.usage.input_tokens}/{step.usage.output_tokens} tokens
                                            </span>
                                          )}
                                        </div>
                                        {step.session_id && (
                                          <div className="mt-1 inline-flex items-center gap-1">
                                            <button
                                              onClick={() => {
                                                try {
                                                  localStorage.setItem("jishu:open-session", JSON.stringify({
                                                    sessionId: step.session_id,
                                                    agentId: step.agent_id,
                                                    runId: selectedRun.run_id,
                                                    stepId: step.step_id,
                                                    at: Date.now(),
                                                  }));
                                                  const chatNav = document.querySelector('[data-page="chat"]') as HTMLElement;
                                                  chatNav?.click();
                                                } catch (e) {
                                                  console.error("Failed to open session", e);
                                                }
                                              }}
                                              className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20"
                                            >
                                              💬 {t("tasks.openSession")} ({step.session_id.slice(0, 12)})
                                            </button>
                                            <button
                                              onClick={() => {
                                                if (!step.session_id) return;
                                                try {
                                                  const name = step.agent_display_name || step.agent_id;
                                                  const projectEncoded = selectedRun.spec.project_path ?? "";
                                                  openFloatingSession(
                                                    step.session_id,
                                                    name,
                                                    step.agent_id,
                                                    projectEncoded,
                                                    step.agent_display_name ?? undefined,
                                                  ).catch(console.error);
                                                } catch (e) {
                                                  console.error("Failed to float session", e);
                                                }
                                              }}
                                              title={t("tasks.floatSession")}
                                              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/70"
                                            >
                                              ⤴ {t("tasks.floatSession")}
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                      {/* Status pill — clickable for AwaitingApproval */}
                                      {isAwaiting ? (
                                        <button
                                          onClick={() => {
                                            // Scroll to the pending approval card at the top of the drawer
                                            const card = document.getElementById(`approval-${step.step_id}`);
                                            card?.scrollIntoView({ behavior: "smooth", block: "center" });
                                            card?.classList.add("ring-2", "ring-amber-500");
                                            setTimeout(() => card?.classList.remove("ring-2", "ring-amber-500"), 1500);
                                          }}
                                          className="inline-flex animate-pulse items-center gap-1 rounded-full border-2 border-amber-500 bg-amber-500/20 px-3 py-1 text-xs font-bold uppercase text-amber-700 transition-colors hover:bg-amber-500/30 dark:text-amber-300"
                                          title={t("tasks.expanded")}
                                        >
                                          ⚠ {t("tasks.pending")}
                                        </button>
                                      ) : (
                                        <Badge
                                          variant={
                                            isComplete ? "default" :
                                            isFailed ? "destructive" :
                                            isRunning ? "default" :
                                            "secondary"
                                          }
                                          className={`text-[10px] ${isRunning ? "animate-pulse" : ""}`}
                                        >
                                          {t(`tasks.status.${step.status}`)}
                                        </Badge>
                                      )}
                                    </div>
                                  </div>
                                </li>
                              );
                            })}
                        </ol>
                      )
                    ) : (
                      /* Parallel Gantt view: rows = roles, columns = time */
                      <ParallelGantt steps={selectedRun.result.steps ?? []} runStartedAt={selectedRun.result.started_at} />
                    )}
                  </>
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

/**
 * Simple parallel Gantt chart for visualizing multi-step, multi-role execution.
 * Each row is a role; horizontal bars show each step's start/duration.
 * Steps without started_at/finished_at are shown as pending.
 */

