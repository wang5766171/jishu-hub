/**
 * plugin-invoke —— 通用插件动作调用扩展（v0.9.5 需求1（原需求26）6b，方向四）。
 *
 * 机制（方案 B，评审 P0-2 定案）：hub 物化启用的 [[agent-tool]] 声明到
 * `~/.jishu-hub/agent-tools.json`（hub 权威写、本扩展只读）→ 启动时读清单
 * 逐项 `pi.registerTool` 动态注册为 agent 工具（agent 在对话中按 description
 * 判断时机）→ 调用经 `\x00hub_invoke:` 桥直达 Rust 闸门（校验存在 + 向
 * webview 广播 plugin-tool-invoke——前端动作链执行，UI 类动作异步呈现）。
 *
 * pi v0.87.1 硬约束：registerTool 必须带 object parameters schema——声明
 * 缺省时兜底空 Type.Object({})（清单 parameters 可选）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface AgentToolEntry {
  pluginId: string;
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/** 物化清单路径（hub 权威写——materialize_agent_tools）。 */
function agentToolsPath(): string {
  return path.join(os.homedir(), ".jishu-hub", "agent-tools.json");
}

function loadAgentTools(): AgentToolEntry[] {
  try {
    const content = fs.readFileSync(agentToolsPath(), "utf-8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? (parsed as AgentToolEntry[]) : [];
  } catch {
    return []; // 文件缺失/损坏——注册面为空（hub 未物化或全部停用）。
  }
}

export default function pluginInvokeExtension(pi: ExtensionAPI): void {
  const tools = loadAgentTools();
  for (const entry of tools) {
    pi.registerTool({
      name: entry.name,
      label: entry.name,
      description:
        entry.description ||
        `触发 Jishu Hub 插件 ${entry.pluginId} 的动作。用户明确要求该操作时使用。`,
      parameters: (entry.parameters as never) ?? Type.Object({}),
      execute: async (args: Record<string, unknown>) => {
        // hub_invoke 桥（与 html-preview 同机制）：select 标题携带
        // {command, params} JSON——Rust 识别直达后端，响应 value 为
        // {success, data} JSON 字符串。
        const payload = JSON.stringify({
          command: "plugin_invoke",
          params: { tool: entry.name, args: args ?? {} },
        });
        let ok = false;
        try {
          const result = await pi.context.ui.select(`\x00hub_invoke:${payload}`, ["\x00ok"]);
          if (result) {
            const parsed = JSON.parse(result) as { success?: boolean };
            ok = parsed?.success === true;
          }
        } catch {
          ok = false;
        }
        return {
          content: [
            {
              type: "text" as const,
              text: ok
                ? `已触发插件动作 ${entry.name}（插件 ${entry.pluginId}）——效果将在 Hub 界面呈现。`
                : `插件动作 ${entry.name} 触发失败（插件可能已停用或 Hub 未运行）。`,
            },
          ],
        };
      },
    });
  }
}
