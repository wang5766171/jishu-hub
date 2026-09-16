/**
 * 动作实现（需求13 C1/C2）。@config.<key> 引用由引擎在 run 前解析为插件
 * 配置值；export-file 经渲染组件 capabilities.toFile 转换。
 */
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { ActionDeclaration, SourcePayload } from "../types";
import { actionRegistry } from "./registry";

export { actionRegistry };

/** blob → base64（分块防栈溢出）。 */
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** export-file：渲染组件 toFile → 保存对话框 → 写文件。 */
actionRegistry.register({
  type: "export-file",
  async run(params, payload) {
    const format = String(params.format ?? "txt");
    const toFile = params.__toFile as ((p: SourcePayload, f: string) => Promise<Blob | string>) | undefined;
    if (!toFile) throw new Error(`渲染组件不支持导出 ${format}`);
    const out = await toFile(payload, format);
    const path = await save({ defaultPath: `export.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (!path) return;
    if (typeof out === "string") {
      await invoke("export_text_file", { path, content: out });
    } else {
      await invoke("export_binary_file", { path, base64Data: await blobToBase64(out) });
    }
  },
});

/** open-external：系统默认应用打开文本内容（临时文件）或路径。 */
actionRegistry.register({
  type: "open-external",
  async run(params, payload) {
    if (payload.kind === "code-block") {
      await invoke("open_html_external", { html: payload.code });
      return;
    }
    if (typeof params.path === "string") {
      await invoke("reveal_in_file_manager", { path: params.path });
    }
  },
});

/** clipboard：复制 payload 文本。 */
actionRegistry.register({
  type: "clipboard",
  async run(_params, payload) {
    const text = payload.kind === "code-block" ? payload.code : JSON.stringify(payload, null, 2);
    await navigator.clipboard.writeText(text);
  },
});

/** desktop-notify：桌面通知（含静音时段/提示音配置语义，迁自 builtin 插件）。 */
function inQuietHours(range: string, now = new Date()): boolean {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(range.trim());
  if (!m) return false;
  const toMin = (h: string, min: string) => Number(h) * 60 + Number(min);
  const start = toMin(m[1], m[2]);
  const end = toMin(m[3], m[4]);
  const cur = now.getHours() * 60 + now.getMinutes();
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

actionRegistry.register({
  type: "desktop-notify",
  async run(params, _payload, ctx) {
    const options = (params.__options ?? {}) as Record<string, unknown>;
    const soundOn = typeof options.sound === "boolean" ? options.sound : true;
    const quiet = inQuietHours(String(options.quietHours ?? ""));
    const title = String(params.title ?? "通知");
    const body = String(params.body ?? "");
    try {
      await invoke("desktop_notify_send", {
        title,
        body,
        sessionId: ctx.sessionId ?? null,
        sound: !quiet && soundOn ? null : false,
      });
    } catch (error) {
      console.warn("desktop notify failed:", error);
    }
  },
});

/** jump：跳转定位（turn/message；dock/list 类组件动作）。 */
actionRegistry.register({
  type: "jump",
  async run(params) {
    const index = Number(params.turn ?? params.message ?? 0);
    const customEvent = new CustomEvent("jishu-capability-jump", { detail: { index } });
    window.dispatchEvent(customEvent);
  },
});

/** insert-composer：插入输入框（经能力跳转事件协议，宿主侧接线）。 */
actionRegistry.register({
  type: "insert-composer",
  async run(params) {
    window.dispatchEvent(new CustomEvent("jishu-capability-insert", { detail: { text: String(params.text ?? "") } }));
  },
});

/** @config.<key> 解析（引擎调用）：把声明里的配置引用换成当前值。 */
export function resolveActionParams(
  action: ActionDeclaration,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(action)) {
    if (typeof v === "string" && v.startsWith("@config.")) {
      out[k] = options[v.slice("@config.".length)];
    } else {
      out[k] = v;
    }
  }
  return out;
}
