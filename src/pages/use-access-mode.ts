/**
 * 访问/权限模式域（v0.9.3 需求10 M3 设置面板接线，chat-page 拆解）：
 * 三种提供方（project_settings / hub_tool_mode / agent_config）的当前模式
 * 加载、选项/标签派生、变更保存、刷新键整体迁出。
 *
 * 职责边界：本钩子拥有 projectSettings 查询、外部模式查询与 accessRefreshKey
 * 刷新键——全部读写点在域内；页面消费派生值与 handleChange/refresh。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { useInvoke } from "@/hooks/use-invoke";
import type { ProjectSettings } from "@/types";

export interface AccessModeDeps {
  activeId: string | null;
  /** 智能体声明的权限模式枚举（空 = 不支持切换）。 */
  permissionModes: string[];
  /** 提供方："project_settings" | "hub_tool_mode" | "agent_config" | null。 */
  permissionModeProvider: string | null;
  /** 项目根（project_settings 提供方读写用）。 */
  projectPath: string | null;
}

export function useAccessMode(deps: AccessModeDeps) {
  const { t } = useTranslation();
  const { activeId, permissionModes, permissionModeProvider, projectPath } = deps;
  const canSwitch = permissionModes.length > 0;

  const [accessRefreshKey, setAccessRefreshKey] = useState(0);
  const { data: projectSettings } = useInvoke<ProjectSettings>(
    permissionModeProvider === "project_settings" && projectPath && activeId ? "load_project_settings_local" : "",
    permissionModeProvider === "project_settings" && projectPath && activeId ? { agentId: activeId, projectPath } : undefined,
    accessRefreshKey,
  );
  // hub_tool_mode / agent_config 提供方的当前模式（project_settings 走上面的 useInvoke）
  const [externalPermissionMode, setExternalPermissionMode] = useState<string | null>(null);
  useEffect(() => {
    if (permissionModeProvider !== "hub_tool_mode" && permissionModeProvider !== "agent_config") {
      setExternalPermissionMode(null);
      return;
    }
    let cancelled = false;
    const cmd = permissionModeProvider === "hub_tool_mode" ? "get_agent_tool_mode" : "get_agent_permission_mode";
    invokeCommand<string | null>(cmd, { agentId: activeId ?? "" })
      .then((v) => { if (!cancelled) setExternalPermissionMode(v ?? null); })
      .catch(() => { if (!cancelled) setExternalPermissionMode(null); });
    return () => { cancelled = true; };
  }, [permissionModeProvider, activeId, accessRefreshKey]);

  const options = useMemo(() => {
    const labels: Record<string, string> = {
      default: t("sessions.accessDefault"),
      bypassPermissions: t("sessions.accessBypass"),
      plan: t("sessions.accessPlan"),
      full: t("sessions.toolModeFull"),
      "full-approve": t("sessions.toolModeFullApprove"),
      "smart-approve": t("sessions.toolModeSmartApprove"),
      readonly: t("sessions.toolModeReadonly"),
      untrusted: t("sessions.approvalUntrusted"),
      "on-failure": t("sessions.approvalOnFailure"),
      "on-request": t("sessions.approvalOnRequest"),
      never: t("sessions.approvalNever"),
    };
    const descriptions: Record<string, string> = {
      full: t("sessions.toolModeFullDesc"),
      "full-approve": t("sessions.toolModeFullApproveDesc"),
      "smart-approve": t("sessions.toolModeSmartApproveDesc"),
      readonly: t("sessions.toolModeReadonlyDesc"),
    };
    return permissionModes.map((value) => ({
      value,
      label: labels[value] ?? value,
      description: descriptions[value],
    }));
  }, [permissionModes, t]);

  const value = permissionModeProvider === "project_settings"
    ? projectSettings?.permissions?.defaultMode || "default"
    : permissionModeProvider === "hub_tool_mode"
      ? externalPermissionMode ?? "full"
      : externalPermissionMode;
  // 变更前审批档的策略链不含 Once 记忆，审批弹窗不提供「始终允许」。
  const approvalAlwaysHidden =
    permissionModeProvider === "hub_tool_mode" && value === "full-approve";
  const label = value
    ? options.find((option) => option.value === value)?.label ?? value
    : t("sessions.accessUnset");

  /** 切换访问/权限模式：按提供方分流保存（项目设置本地/工具模式/agent 配置）。 */
  const handleChange = useCallback(async (mode: string) => {
    if (!canSwitch || !activeId) return;
    try {
      if (permissionModeProvider === "project_settings") {
        if (!projectPath) return;
        const nextSettings: ProjectSettings = {
          permissions: {
            defaultMode: mode === "default" ? null : mode,
            allow: projectSettings?.permissions?.allow ?? null,
            deny: projectSettings?.permissions?.deny ?? null,
          },
          hooks: projectSettings?.hooks ?? null,
          env: projectSettings?.env ?? null,
          model: projectSettings?.model ?? null,
        };
        await invokeCommand("save_project_settings_local", { agentId: activeId, projectPath, settings: nextSettings });
      } else if (permissionModeProvider === "hub_tool_mode") {
        (await import("@/lib/dev-log")).devLog("ipc", "切换工具模式", { mode });
        await invokeCommand("set_agent_tool_mode", { agentId: activeId, mode });
      } else if (permissionModeProvider === "agent_config") {
        (await import("@/lib/dev-log")).devLog("ipc", "切换权限模式", { mode });
        await invokeCommand("set_agent_permission_mode", { agentId: activeId, mode });
      }
    } finally {
      setAccessRefreshKey(Date.now());
    }
  }, [canSwitch, activeId, permissionModeProvider, projectPath, projectSettings]);

  /** 手动触发重查（页面头部刷新/模型变更后同步访问模式显示）。 */
  const refresh = useCallback(() => setAccessRefreshKey(Date.now()), []);

  return {
    /** 是否支持切换（权限模式枚举非空）。 */
    canSwitch,
    options,
    value,
    label,
    approvalAlwaysHidden,
    handleChange,
    refresh,
  };
}
