/**
 * html-preview — Pi 扩展：注册 preview_html 工具（v0.9.2 测试期，用户需求：
 * agent 开发 HTML 页面后可主动在 Hub 右侧面板渲染展示，而非靠 markdown 代码块嵌套）。
 *
 * 工具经 \x00hub_invoke: 桥（与 conductor 扩展同一机制，见 pi_rpc_runtime.rs
 * handle_hub_invoke）调用 Hub 后端 plugin_preview_html：校验文件后向前端广播
 * session-plugin-preview 事件，会话插件 session.html-preview 的停靠面板接收
 * 并渲染。是否调用由 agent 自行判断（工具描述里写明适用场景），不强制。
 *
 * 治理：resources/plugins/html-preview/plugin.toml 纯闸门声明 tools =
 * ["preview_html"]，随插件启停热联动 spawn --tools 白名单（同 interactive-qa
 * 之于 request_user_input）。
 */
import { isAbsolute, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface HubInvokeResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/** 与 conductor 扩展同款的 Hub 桥：经 select 标记编码调用，Hub 拦截执行并响应。 */
async function hubInvoke(
  ctx: ExtensionContext,
  command: string,
  params: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<HubInvokeResult | null> {
  try {
    const payload = JSON.stringify({ command, params });
    const selectPromise = ctx.ui.select(`\x00hub_invoke:${payload}`, ["\x00ok"]);
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs),
    );
    const result = await Promise.race([selectPromise, timeoutPromise]);
    if (!result) return null;
    return JSON.parse(result) as HubInvokeResult;
  } catch {
    return null;
  }
}

export default function htmlPreviewExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "preview_html",
    label: "HTML 页面预览",
    description:
      "把一个本地 HTML 文件在 Hub 界面右侧的预览面板中渲染展示。适用场景：你为用户开发或修改了 HTML 页面（登录页、单文件 demo、可视化原型等），在交付说明或自检视觉效果时调用，用户即可在界面右侧直接看到渲染结果（可交互脚本会执行）。参数 file 为该 HTML 文件路径（相对当前工作目录或绝对路径）。是否调用由你判断：纯后端/脚本/无视觉意义的产物不要调用；同一文件多次修改后可再次调用以刷新预览。",
    parameters: Type.Object({
      file: Type.String({
        description: "HTML 文件路径（相对当前工作目录或绝对路径，需为 .html/.htm）",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const resolved = isAbsolute(params.file)
        ? params.file
        : join(process.cwd(), params.file);
      const result = await hubInvoke(
        ctx,
        "plugin_preview_html",
        { file: resolved, session_id: ctx.sessionManager.getSessionId() },
        8000,
      );
      if (result === null) {
        return {
          content: [
            {
              type: "text" as const,
              text: "预览请求已发出，但 Hub 未响应（桥接超时）。用户可能未打开 Hub 界面；不影响你继续工作，可照常交付并说明文件路径。",
            },
          ],
          details: {},
        };
      }
      if (result.success === false) {
        return {
          content: [{ type: "text" as const, text: `预览未打开：${result.error ?? "未知错误"}` }],
          details: {},
        };
      }
      const data = result.data as { file?: string } | undefined;
      return {
        content: [
          {
            type: "text" as const,
            text: `已在 Hub 右侧预览面板渲染该页面${data?.file ? `（${data.file}）` : ""}。用户可直接查看；再次调用本工具可刷新预览。`,
          },
        ],
        details: {},
      };
    },
  });
}
