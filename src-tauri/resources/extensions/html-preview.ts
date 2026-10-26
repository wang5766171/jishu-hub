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
      "在 Hub 界面右侧的预览面板中渲染网页内容，两种模式按场景选择。【url 模式——前端项目开发首选】你正在开发的前端项目（vite/webpack/CRA 等）已用 shell 启动 dev server 时，传 url 参数（如 http://localhost:5173）——面板直连 dev server，外链 CSS/JS、热更新全部正常；不要为了预览把资源内联进单文件，也不要用文件模式预览多文件项目。【file 模式——单文件交付物】你为用户开发或修改了自包含的 HTML 文件（登录页、报告页、单文件应用等）时传 file 参数。注意：用户只想看图表/流程图时不要用本工具，直接在回复中输出 ```mermaid 代码块（会话界面原生渲染，详见 jishu-hub-capabilities skill）。",
    parameters: Type.Object({
      url: Type.Optional(
        Type.String({
          description:
            "dev server 地址（仅限本机 http://localhost:端口 或 http://127.0.0.1:端口）。前端项目开发场景先启动 dev server 再传此参数",
        }),
      ),
      file: Type.Optional(
        Type.String({
          description: "自包含 HTML 文件路径（相对当前工作目录或绝对路径，需 .html/.htm）",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      // url 模式：dev server 直连预览（Hub 后端校验回环地址后广播事件）。
      if (params.url && params.url.trim()) {
        const result = await hubInvoke(
          ctx,
          "plugin_preview_html",
          { url: params.url.trim(), session_id: ctx.sessionManager.getSessionId() },
          8000,
        );
        if (result === null) {
          return {
            content: [
              {
                type: "text" as const,
                text: "预览请求已发出，但 Hub 未响应（桥接超时）。用户可能未打开 Hub 界面；不影响你继续工作。",
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
        return {
          content: [
            {
              type: "text" as const,
              text: `已在 Hub 右侧预览面板打开该地址（${params.url}）。面板直连 dev server，样式与热更新正常；用户修改代码后面板可点刷新查看最新效果。`,
            },
          ],
          details: {},
        };
      }
      const filePath = params.file?.trim();
      if (!filePath) {
        return {
          content: [
            {
              type: "text" as const,
              text: "参数缺失：前端项目传 url（dev server 地址），自包含单文件传 file。",
            },
          ],
          details: {},
        };
      }
      const resolved = isAbsolute(filePath) ? filePath : join(process.cwd(), filePath);
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
