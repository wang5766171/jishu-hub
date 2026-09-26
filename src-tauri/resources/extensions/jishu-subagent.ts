/**
 * jishu-subagent —— 通用任务委派扩展（v0.9.5 需求2）。
 *
 * 场景：主模型（如 GLM-5.3，无图像能力）把子任务委派给具备对应能力的
 * 模型（如 GLM-5.3-FLASH 识图）作为 subagent 执行，结果回传主会话。
 * **模型自动选择**（用户诉求：不说用哪个模型，agent 自己知道）：
 * - 渠道模型目录可查询（list_subagent_models 工具 + 每轮注入简表）；
 * - dispatch_subagent 带 images 且未指定 model 时，自动选择支持识图的
 *   模型（激活渠道优先）——用户贴图即可，无需点名模型。
 *
 * 机制：pi print mode 单轮子进程（`pi --provider X --model Y -p "<task>"
 * @img1 @img2`）：stdout = 最终回复；每次全新会话（不污染主会话）。
 * hub 经 env 注入 JISHU_PI_CLI（cli.js 路径）与 JISHU_ACTIVE_MODEL
 * （provider|model）；node 用 process.execPath。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// getAgentDir：pi 权威数据目录 API（~/.jishu-agent/agent——models.json
// / settings.json 所在）。扩展跑在 pi 进程内直接问 pi，零 env 零反推。
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

/** 默认超时（秒）。 */
const DEFAULT_TIMEOUT_SECS = 120;
/** 子进程 stdout 上限（字节）。 */
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
 * （getAgentDir = ~/.jishu-agent/agent）。扩展跑在 pi 进程内，直接问 pi，
 * 零 env 零反推（hub 与扩展无需互相告知安装布局）。 */
function agentDir(): string {
  return getAgentDir();
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
    return out.filter((m) => m.id);
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
          "⚠ 图片路径直取：用户消息带图片时，消息中的附件行（形如「图片1（批次 …）: C:\…\pasted-image-0.png」）就是图片的**磁盘绝对路径**——直接取该路径作为 images 参数传给 dispatch_subagent，不要用 ls/find/grep 搜索文件，也不要先读图自己描述。",
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
      "把一个自包含的子任务委派给指定模型的 subagent（独立干净会话执行，结果作为文本返回）。" +
      "典型用途：你不能识图而任务含图片——从用户消息的附件行（图片N（批次 …）: <绝对路径>）取图片磁盘路径传入 images，并省略 model（自动选择支持图像的模型）。同一智能体内的模型委派，与切换智能体无关。" +
      "长文摘要、独立验证等也适用。何时不该用：任务简单或依赖当前会话上下文时直接自己做。" +
      "task 必须完全自包含（subagent 看不到当前对话）。",
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
              text: "dispatch_subagent：当前模型目录中没有支持图像输入的模型（可用 list_subagent_models 核对）——无法自动识图。",
            }],
          };
        }
      }
      const cli = piCliPath();
      const cliArgs: string[] = [];
      if (provider) cliArgs.push("--provider", provider);
      if (model) cliArgs.push("--model", model);
      cliArgs.push("--no-auto-retry"); // 一次性任务：失败快速失败（不进 retry 退避）
      cliArgs.push("--print", task);
      for (const img of images) {
        cliArgs.push(img.startsWith("@") ? img : `@${img}`);
      }
      const startedAt = Date.now();
      // 进度透传（10s 心跳——主会话前端不再「思考中」无反馈；pi 经
      // tool_execution_update 事件转发 onUpdate 部分结果）。
      const progressTimer = setInterval(() => {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        onUpdate?.({
          content: [{ type: "text" as const, text: `subagent ${model || "auto-model"} 运行中… ${secs}s` }],
        });
      }, 10_000);
      const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
        const child = execFile(
          process.execPath,
          [cli, ...cliArgs],
          {
            timeout: timeoutSecs * 1000,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
            cwd: process.cwd(),
            env: { ...process.env },
          },
          (err, stdout, stderr) => {
            const code = err && typeof (err as { code?: unknown }).code === "number"
              ? ((err as { code?: unknown }).code as number)
              : err ? null : 0;
            resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
          },
        );
        // 用户停止（pi abort 工具执行）→ 杀子进程（否则 print mode 继续跑
        // 到超时，主会话「停止后仍挂」体感来源之一）。
        signal?.addEventListener("abort", () => {
          try { child.kill(); } catch { /* 已退出 */ }
        }, { once: true });
      });
      clearInterval(progressTimer);
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const out = result.stdout.trim();
      if (!out) {
        const detail = result.stderr.trim().slice(0, 600);
        return {
          content: [{
            type: "text" as const,
            text:
              `dispatch_subagent 失败（${elapsed}s，exit=${result.code}）` +
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
