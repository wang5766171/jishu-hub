/**
 * jishu-subagent —— 通用任务委派扩展（v0.9.5 需求2）。
 *
 * 机制：pi print mode（--mode json 事件流）子进程——spawn 逐行解析，
 * 子 agent 的思考/回答实时经 onUpdate 转发（主会话工具卡的实时输出区
 * 可展开查看子 agent 过程，不产生独立会话）：
 * - stdin=ignore（pi print 检测非 TTY 等 EOF——pipe 挂死教训的根治形态）；
 * - 会话目录隔离：JISHU_CODING_AGENT_SESSION_DIR 指到 ~/.jishu-hub/
 *   subagent-sessions/<nonce>/（hub 会话列表不扫描，文件保留可回溯）；
 * - 结果 = 流中最后一条 assistant 消息的文本聚合。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// getAgentDir：pi 权威数据目录 API（~/.jishu-agent/agent——models.json
// / settings.json 所在）。扩展跑在 pi 进程内直接问 pi，零 env 零反推。
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

/** 默认超时（秒）。 */
const DEFAULT_TIMEOUT_SECS = 120;
/** stdout 累计上限（字节）。 */
const MAX_OUTPUT_BYTES = 512 * 1024;

interface ModelEntry {
  provider: string;
  id: string;
  name: string;
  input: string[];
  reasoning: boolean;
  contextWindow?: number;
}

function piCliPath(): string {
  const fromEnv = process.env["JISHU_PI_CLI"];
  if (fromEnv && fromEnv.trim()) return fromEnv;
  const self = process.argv[1] ?? "";
  return path.join(path.dirname(self), "cli.js");
}

/** pi 数据目录（models.json / settings.json 所在）——pi 权威 API 直达
 * （getAgentDir = ~/.jishu-agent/agent）。 */
function agentDir(): string {
  return getAgentDir();
}

/** 会话可见模型清单（hub 注入 JISHU_VISIBLE_MODELS——"provider/id" 逗号
 * 分隔；hub 侧已剔除显式隐藏）。null = env 未注入（无隐藏记录）= 全可见。
 * 目录/自动选模/指南统一在 readModelCatalog 出口过滤。 */
function visibleFilter(): Set<string> | null {
  const raw = process.env["JISHU_VISIBLE_MODELS"];
  if (!raw || !raw.trim()) return null;
  return new Set(
    raw.split(",").map((s) => s.trim()).filter(Boolean),
  );
}

/** 渠道模型目录（~/.jishu-agent/agent/models.json → 扁平条目）。 */
function readModelCatalog(): ModelEntry[] {
  try {
    const file = path.join(agentDir(), "models.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      providers?: Record<string, { models?: Array<Record<string, unknown>> }>;
    };
    const out: ModelEntry[] = [];
    for (const [provider, p] of Object.entries(parsed.providers ?? {})) {
      for (const m of p.models ?? []) {
        out.push({
          provider,
          id: String(m["id"] ?? ""),
          name: String(m["name"] ?? m["id"] ?? ""),
          input: Array.isArray(m["input"]) ? m["input"].map(String) : ["text"],
          reasoning: Boolean(m["reasoning"]),
          contextWindow: typeof m["contextWindow"] === "number" ? m["contextWindow"] : undefined,
        });
      }
    }
    let entries = out.filter((m) => m.id);
    // 可见性过滤（hub 清单——显式隐藏的模型不进目录/自动选/指南）。
    const allow = visibleFilter();
    if (allow) {
      entries = entries.filter((m) => allow.has(`${m.provider}/${m.id}`));
    }
    return entries;
  } catch {
    return [];
  }
}

/** 激活 (provider, model)——hub 注入的 JISHU_ACTIVE_MODEL（"provider|model"）。 */
function activeProvider(): string {
  const raw = process.env["JISHU_ACTIVE_MODEL"] ?? "";
  return raw.split("|")[0] ?? "";
}

/** 自动选择识图模型：激活渠道内支持 image 输入者优先，其次跨渠道首个。 */
function autoSelectVisionModel(): ModelEntry | null {
  const catalog = readModelCatalog();
  const vision = catalog.filter((m) => m.input.includes("image"));
  if (vision.length === 0) return null;
  const ap = activeProvider();
  return vision.find((m) => m.provider === ap) ?? vision[0] ?? null;
}

/** 目录简表（指南注入与查询工具共用）。 */
function catalogSummary(): string {
  const catalog = readModelCatalog();
  if (catalog.length === 0) return "（models.json 不可读——委派时请显式指定 model）";
  const ap = activeProvider();
  return catalog
    .map((m) => {
      const caps: string[] = [];
      if (m.input.includes("image")) caps.push("识图");
      if (m.reasoning) caps.push("推理");
      const tags = caps.length ? `（${caps.join("+")}）` : "";
      const active = m.provider === ap ? " [当前渠道]" : "";
      return `- ${m.provider} / ${m.id}${tags}${active}`;
    })
    .join("\n");
}

/** 子会话隔离目录（hub 不扫描；文件保留可回溯）。 */
function subagentSessionDir(): string {
  const dir = path.join(
    os.homedir(),
    ".jishu-hub",
    "subagent-sessions",
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 从 json 事件流的一行提取文本增量（assistant 内容流）。 */
function extractDelta(lineJson: string): { thinking?: string; text?: string } | null {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(lineJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (ev["type"] !== "message_update") return null;
  const ame = ev["assistantMessageEvent"] as Record<string, unknown> | undefined;
  if (!ame) return null;
  const t = ame["type"];
  if (t === "text_delta" && typeof ame["text"] === "string") return { text: ame["text"] };
  if (t === "thinking_delta" && typeof ame["thinking"] === "string") return { thinking: ame["thinking"] };
  return null;
}

/** 从 json 事件流的 message_end 提取完整 assistant 文本（权威最终结果）。 */
function extractFinalText(lineJson: string): string | null {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(lineJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (ev["type"] !== "message_end") return null;
  const msg = ev["message"] as Record<string, unknown> | undefined;
  if (!msg || msg["role"] !== "assistant") return null;
  const content = msg["content"];
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const b of content) {
    if ((b as Record<string, unknown>)["type"] === "text") {
      const s = (b as Record<string, unknown>)["text"];
      if (typeof s === "string" && s) texts.push(s);
    }
  }
  return texts.length ? texts.join("\n") : null;
}

export default function jishuSubagentExtension(pi: ExtensionAPI): void {
  // ── 每轮注入委派指南（agent「自己知道」的关键——贴图不必点名模型）──
  pi.on("before_agent_start", async () => {
    return {
      message: {
        customType: "jishu-subagent-guide",
        display: false,
        content: [
          "[SUBAGENT 委派能力]",
          "当你发现某类任务超出自身能力（如无法读取图片内容）时，把任务委派给下方目录中**具备该能力的模型**执行——调用 dispatch_subagent 工具即可。",
          "⚠ 委派不是切换智能体：仍在同一智能体内，仅子任务换模型执行。不要去查询/切换其他智能体来完成这类任务。",
          "⚠ 图片路径直取：用户消息带图片时，消息中的附件行（形如「图片1（批次 …）: C:…pasted-image-0.png」）就是图片的**磁盘绝对路径**——直接取该路径作为 images 参数传给 dispatch_subagent，不要用 ls/find/grep 搜索文件，也不要先读图自己描述。",
          "task 写清完整要求（自包含——subagent 看不到本对话）；省略 model 且带 images 时自动选择支持图像输入的模型。task 必须按用户实际问题定制识别目标：把用户问题转写成针对图片的具体分析任务（问数据就读数据、问文字就提取文字、问布局就描述布局），不要写「识别这张图」这类泛泛指令。",
          "何时不委派：任务你自己能做、或强依赖当前会话上下文。",
          "可用模型目录（含能力标注）：",
          catalogSummary(),
        ].join("\n"),
      },
    };
  });

  // ── 模型目录查询（显式查询通道；指南已含简表，此工具供细节核对）──
  pi.registerTool({
    name: "list_subagent_models",
    label: "查询可用模型",
    description:
      "查询当前可委派的模型目录（各渠道 provider 下的模型及能力标注：识图/推理/上下文窗口）。" +
      "dispatch_subagent 前不确定模型 id 或能力时查询；带 images 的委派省略 model 会自动选择识图模型，通常无需先查。",
    parameters: Type.Object({}),
    execute: async () => {
      return {
        content: [{ type: "text" as const, text: `可用模型目录（provider / model）:\n${catalogSummary()}` }],
      };
    },
  });

  pi.registerTool({
    name: "dispatch_subagent",
    label: "委派 subagent",
    description:
      "把一个自包含的子任务委派给指定模型的 subagent（独立干净会话执行，过程与结果回传本会话工具卡——可展开实时查看子 agent 的思考与回答）。" +
      "典型用途：你不能识图而任务含图片——从用户消息的附件行（图片N（批次 …）: <绝对路径>）取图片磁盘路径传入 images，并省略 model（自动选择支持图像的模型）。同一智能体内的模型委派，与切换智能体无关。" +
      "长文摘要、独立验证等也适用。何时不该用：任务你能做、或强依赖当前会话上下文（subagent 看不到本对话）。",
    promptSnippet:
      "dispatch_subagent: 委派子任务给其他模型（带图时省略 model=自动选识图模型），task 须自包含",
    parameters: Type.Object({
      task: Type.String({
        description: "委派任务描述（自包含）。⚠ 按用户实际问题定制：把用户问题转写成针对输入（图片等）的具体分析任务——用户问图表数据就写「读取图表并回答X」，不要写「识别这张图」这类泛泛指令。subagent 看不到当前对话，目标/输入说明/期望产出格式都要写全。",
      }),
      model: Type.Optional(
        Type.String({
          description: "目标模型 id（须在 models.json 中，可用 list_subagent_models 查询）。省略且带 images 时自动选择识图模型；省略且无 images 用默认模型",
        }),
      ),
      provider: Type.Optional(
        Type.String({ description: "目标 provider 名（与 model 配对；缺省自动解析）" }),
      ),
      images: Type.Optional(
        Type.Array(Type.String(), {
          description: "图片文件绝对路径（识图；相对路径以当前工作目录解析）",
        }),
      ),
      timeout_secs: Type.Optional(
        Type.Number({ description: `超时秒数（默认 ${DEFAULT_TIMEOUT_SECS}）` }),
      ),
    }),
    execute: async (_id, args, signal, onUpdate) => {
      const task = String(args.task ?? "").trim();
      if (!task) {
        return { content: [{ type: "text" as const, text: "dispatch_subagent: task 不能为空" }] };
      }
      const timeoutSecs = Number(args.timeout_secs) > 0 ? Number(args.timeout_secs) : DEFAULT_TIMEOUT_SECS;
      const images = Array.isArray(args.images) ? args.images.map(String).filter(Boolean) : [];
      let provider = args.provider ? String(args.provider) : "";
      let model = args.model ? String(args.model) : "";
      let autoNote = "";
      // 自动选模：带图未指定 model → 识图模型（激活渠道优先）。
      if (!model && images.length > 0) {
        const picked = autoSelectVisionModel();
        if (picked) {
          model = picked.id;
          provider = picked.provider;
          autoNote = `（自动选择识图模型 ${picked.provider}/${picked.id}）`;
        } else {
          return {
            content: [{
              type: "text" as const,
              text: "dispatch_subagent：当前可见模型中没有支持图像输入的模型（可用 list_subagent_models 核对）——无法自动识图。",
            }],
          };
        }
      }
      const cli = piCliPath();
      const cliArgs: string[] = [];
      if (provider) cliArgs.push("--provider", provider);
      if (model) cliArgs.push("--model", model);
      cliArgs.push("--mode", "json", task);
      for (const img of images) {
        cliArgs.push(img.startsWith("@") ? img : `@${img}`);
      }

      // 子会话隔离目录（不进 hub 会话列表；JSONL 保留可回溯）。
      const sessionDir = subagentSessionDir();
      const startedAt = Date.now();

      const result = await new Promise<{ finalText: string; textSnap: string; stderr: string; code: number | null; killed: boolean }>((resolve) => {
        const child = spawn(process.execPath, [cli, ...cliArgs], {
          cwd: process.cwd(),
          env: { ...process.env, JISHU_CODING_AGENT_SESSION_DIR: sessionDir },
          // stdin=ignore：pi print 检测非 TTY 后等 stdin EOF——ignore 天然
          // 立即 EOF（pipe 不关闭会无限挂死——实测教训）。
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          try { child.kill(); } catch { /* 已退出 */ }
        }, timeoutSecs * 1000);
        signal?.addEventListener("abort", () => {
          killed = true;
          try { child.kill(); } catch { /* 已退出 */ }
        }, { once: true });

        let stderr = "";
        let finalText = "";
        // 实时内容快照（onUpdate 转发——主会话工具卡实时输出区）。
        let thinkingSnap = "";
        let textSnap = "";
        let lastPush = 0;
        let bytes = 0;
        let lineBuf = "";
        const pushProgress = (force = false) => {
          const now = Date.now();
          if (!force && now - lastPush < 800) return;
          lastPush = now;
          const parts: string[] = [];
          if (thinkingSnap) parts.push(`[思考] ${thinkingSnap.slice(-600)}`);
          if (textSnap) parts.push(`[回答] ${textSnap.slice(-1200)}`);
          if (parts.length) {
            onUpdate?.({ content: [{ type: "text" as const, text: parts.join("\n") }] });
          }
        };
        child.stdout.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT_BYTES * 4) {
            killed = true;
            try { child.kill(); } catch { /* 防巨量输出 */ }
            return;
          }
          lineBuf += chunk;
          let nl: number;
          while ((nl = lineBuf.indexOf("\n")) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line) continue;
            const final = extractFinalText(line);
            if (final !== null) finalText = final;
            const delta = extractDelta(line);
            if (delta?.thinking) thinkingSnap += delta.thinking;
            if (delta?.text) textSnap += delta.text;
          }
          pushProgress();
        });
        child.stderr.setEncoding("utf-8");
        child.stderr.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-4096);
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ finalText: "", textSnap, stderr: stderr + String(err), code: null, killed });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          pushProgress(true);
          resolve({ finalText, textSnap, stderr, code, killed });
        });
      });

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      // json 流缺 message_end（异常中断）时退化为流内文本快照。
      const out = result.finalText.trim() || result.textSnap.trim();
      if (!out) {
        const detail = result.stderr.trim().slice(0, 600);
        return {
          content: [{
            type: "text" as const,
            text:
              `dispatch_subagent 失败（${elapsed}s，exit=${result.code}${result.killed ? "，超时中止" : ""}）` +
              (detail ? `：${detail}` : "（无输出——检查模型是否支持该任务/图片路径是否存在）"),
          }],
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: `[subagent ${model || "default-model"}${autoNote ? " " + autoNote : ""} · ${elapsed}s]\n${out}`,
        }],
      };
    },
  });
}
