/**
 * ctx.hub 能力面实现（二十三轮/二十四轮用户裁决）——第四轮评审 P1/P2
 * 修复轮从 chat-page 外移的独立模块（3060 行 god-component 中零渲染耦合
 * 的纯函数面，同时使本面可单测——修前桥接逻辑埋在组件 useMemo 里）。
 *
 * 三件事随外移一并修复：
 * ① P1 轮次口径：sessionStats.turnCount 复用唯一权威 buildSessionRows
 *   （连续 assistant 消息含 tool_result-only user 归并为一轮——工具中间
 *   轮不计；修前按 assistant 条数计，带工具调用的会话虚高两三倍）。
 * ② P2 stale 闭包：sendMessage 项目路径经 getProjectPath 读取器（chat-page
 *   传 projectPathRef 读取器）——修前闭包捕获 currentProject，切项目后
 *   新会话落在旧项目。
 * ③ P2 app-overlay ctx 缺口：buildOverlayPluginContext 为应用浮层形态
 *   （会话树外，无会话数据面/命令面）提供仅含 hub 面的受限 ctx。
 *
 * 跨端契约锚点（R4 生产实测对齐）：Rust 侧 snake_case（hub_plugin_sessions/
 * usage_session/get_model_picker_options…）→ 本模块映射为插件视角驼峰，
 * 与 API.md / plugins/types.ts 契约逐字段一致。
 */
import { invokeCommand } from "@/hooks/use-invoke";
import type { HubCapabilities, OverlayPluginContext } from "./types";
import { buildSessionRows } from "@/features/session-kernel/view-model/build-session-rows";
import type { Message } from "@/types";

export interface HubCapabilitiesArgs {
  /** 当前会话 id（sessionStats 默认目标；无会话场景传 null）。 */
  currentSessionId: string | null;
  /** 当前项目编码名（消息级聚合限定当前项目内会话；无会话场景传 null/undefined）。 */
  projectEncodedName?: string | null;
  /** 当前项目路径读取器——**必须传 ref 读取器**（闭包捕获值会 stale：
   * 切项目后 sendMessage 落到旧项目；chat-page 的 projectPathRef 即为此设）。 */
  getProjectPath: () => string;
}

/** 构建 ctx.hub 能力面对象（chat-page useMemo 与 app-overlay 宿主共用）。 */
export function buildHubCapabilities(args: HubCapabilitiesArgs): HubCapabilities {
  return {
    listSessions: async (opts) => {
      type Row = {
        id: string; title: string; agent_id: string | null; project_path: string | null;
        started_at: string | null; last_active: string | null; message_count: number;
        total_cost: number | null; tool_calls: number | null;
      };
      const rows = await invokeCommand<Row[]>(
        "hub_plugin_sessions",
        opts?.projectEncodedName != null ? { projectEncoded: opts.projectEncodedName } : undefined,
      );
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        agentId: r.agent_id,
        projectPath: r.project_path,
        startedAt: r.started_at,
        lastActive: r.last_active,
        messageCount: r.message_count,
        totalCost: r.total_cost,
        toolCallsTotal: r.tool_calls,
      }));
    },
    sessionStats: async (sessionId) => {
      const sid = sessionId ?? args.currentSessionId ?? "";
      // 消息级聚合（工具分布/轮数）：当前项目内会话经 get_session_messages
      //（有解析缓存）；usage.db 精确记账跨项目可用。
      let messageCount = 0;
      let turnCount = 0;
      const toolCallsDist: Record<string, number> = {};
      if (sid && args.projectEncodedName) {
        try {
          type Msg = { role: string; content?: Array<{ type?: string; name?: string }> };
          const msgs = await invokeCommand<Msg[]>("get_session_messages", {
            agentId: "jishu-self",
            sessionId: sid,
            encodedName: args.projectEncodedName,
          });
          messageCount = msgs.length;
          // P1 修复：轮次语义单源——复用 buildSessionRows 归并（连续
          // assistant + tool_result-only user 算一轮），工具中间轮不计。
          turnCount = buildSessionRows(msgs as unknown as Message[]).filter(
            (r) => r.kind === "assistant",
          ).length;
          for (const m of msgs) {
            for (const b of m.content ?? []) {
              if (b.type === "tool_use" && b.name) {
                toolCallsDist[b.name] = (toolCallsDist[b.name] ?? 0) + 1;
              }
            }
          }
        } catch {
          // 跨项目/读取失败：消息级统计留零值，用量面仍返回。
        }
      }
      const usage = await invokeCommand<{ total_cost: number; tool_calls: number } | null>(
        "usage_session",
        { sessionId: sid },
      ).catch(() => null);
      return {
        sessionId: sid,
        messageCount,
        turnCount,
        toolCalls: toolCallsDist,
        totalCost: usage?.total_cost ?? null,
        toolCallsTotal: usage ? usage.tool_calls : null,
      };
    },
    listProjects: async () => {
      const projects = await invokeCommand<Array<{ name: string; path: string }>>("scan_projects");
      return (projects ?? []).map((p) => ({ name: p.name, path: p.path }));
    },
    listAgents: async () => {
      const agents = await invokeCommand<Array<{ id: string; display_name: string; enabled: boolean }>>("list_agents");
      return (agents ?? []).map((a) => ({ id: a.id, displayName: a.display_name, installed: a.enabled }));
    },
    openUrl: (url) => void invokeCommand("open_url", { url }).catch(() => undefined),
    // ── pi 智能体定制面（二十四轮）：驱动/引导/中止/模型控制 ──
    agent: {
      sendMessage: async (opts) => {
        const created = await invokeCommand<{ session_id: string | null } | null>("send_message", {
          agentId: "jishu-self",
          // P2 修复：经读取器取当前项目（闭包捕获 stale currentProject 会让
          // 切项目后的新会话落在旧项目）。
          projectPath: opts.projectPath ?? args.getProjectPath(),
          sessionId: opts.sessionId ?? null,
          message: opts.message,
        });
        return { sessionId: created?.session_id ?? null };
      },
      steer: async (opts) => {
        await invokeCommand("steer_chat", { sessionId: opts.sessionId, message: opts.message });
      },
      abort: async (sessionId) => {
        await invokeCommand("abort_chat", { sessionId });
      },
      models: async () => {
        const opts = await invokeCommand<Array<{ value: string; label: string }>>(
          "get_model_picker_options",
          { agentId: "jishu-self" },
        );
        return (opts ?? []).map((o) => ({ value: o.value, label: o.label }));
      },
      getModel: async (sessionId) => {
        const pair = await invokeCommand<[string, string] | null>("session_model_get", { sessionId });
        return pair ? { provider: pair[0], model: pair[1] } : null;
      },
      setModel: async (opts) => {
        await invokeCommand("session_model_set", {
          sessionId: opts.sessionId,
          provider: opts.provider,
          model: opts.model,
        });
      },
    },
  };
}

/**
 * app-overlay 形态的受限 ctx：应用浮层挂载在会话树外（app.tsx
 * AppOverlayHost），无会话数据面/命令面——仅注入 hub 全局面。无会话上下
 * 文时 sessionStats 默认目标为空（显式传 sessionId 查询），sendMessage
 * 不传 projectPath 时项目路径为空串（建议浮层件显式传 projectPath）。
 */
export function buildOverlayPluginContext(): OverlayPluginContext {
  return {
    hub: buildHubCapabilities({
      currentSessionId: null,
      projectEncodedName: null,
      getProjectPath: () => "",
    }),
  };
}
