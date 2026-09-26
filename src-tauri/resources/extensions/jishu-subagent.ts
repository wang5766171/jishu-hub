/**
 * jishu-subagent —— 通用任务委派扩展（v0.9.5 需求2）。
 *
 * 场景：主模型（如 GLM-5.3，无图像能力）把子任务委派给具备对应能力的
 * 模型（如 GLM-5.3-FLASH 识图）作为 subagent 执行，结果回传主会话。
 *
 * 机制：pi print mode 单轮子进程（agent 进程内 child_process 直跑——
 * `pi --provider X --model Y -p "<task>" @img1 @img2`）：stdout = 最终
 * 回复文本；每次全新会话（不污染主会话上下文）；hub 经 env 注入
 * JISHU_PI_CLI（bundle cli.js 绝对路径），node 用 process.execPath。
 * 图片经 @文件参数进入多模态模型的 ImageContent（main.ts
 * processFileArguments——命令行带图原生支持）。
 *
 * 何时不用：简单文本任务不值得委派（会话冷启动成本）——直接自己做；
 * 需要主会话工具/上下文的任务也不适合（subagent 是干净会话）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";

/** 默认超时（秒）——识图/总结类任务余量。 */
const DEFAULT_TIMEOUT_SECS = 300;
/** 子进程 stdout 上限（字节）——防异常巨量输出撑爆工具结果。 */
const MAX_OUTPUT_BYTES = 512 * 1024;

function piCliPath(): string {
  const fromEnv = process.env["JISHU_PI_CLI"];
  if (fromEnv && fromEnv.trim()) return fromEnv;
  // 兜底：pi 进程自身入口同目录的 cli.js（bundle 布局）。
  const self = process.argv[1] ?? "";
  const sibling = path.join(path.dirname(self), "cli.js");
  return sibling;
}

export default function jishuSubagentExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dispatch_subagent",
    label: "委派 subagent",
    description:
      "**图片/图像识别的唯一正确通道**：当前模型无识图能力时，必须经本工具委派多模态模型（如 glm-5.3-flash）识图——直接传 images 图片路径，不要尝试用 bash 手动拼 CLI 命令（本工具即其封装）。" +
      "把一个自包含的子任务委派给指定模型的 subagent（独立干净会话执行，结果作为文本返回）。" +
      "典型用途：主模型不具备某能力时委派具备该能力的模型——尤其图像识别（传 images 图片绝对路径，" +
      "用多模态模型如 GLM-5.3-FLASH）；长文摘要、独立验证、翻译等也适用。" +
      "何时不该用：任务简单或依赖当前会话上下文/工具时直接自己做，不要委派。" +
      "task 必须完全自包含（subagent 看不到当前对话）。",
    promptSnippet:
      "dispatch_subagent: 委派子任务给指定模型（识图用 images + 多模态模型），task 须自包含",
    parameters: Type.Object({
      task: Type.String({
        description: "委派给 subagent 的完整任务描述（自包含：目标、输入说明、期望产出格式）",
      }),
      model: Type.Optional(
        Type.String({
          description: "目标模型 id（须在 models.json 中，如 glm-5.3-flash）。缺省 = 当前激活模型",
        }),
      ),
      provider: Type.Optional(
        Type.String({ description: "目标 provider 名（与 model 配对；缺省按 models.json 解析）" }),
      ),
      images: Type.Optional(
        Type.Array(Type.String(), {
          description: "图片文件绝对路径（多模态识图；相对路径以当前工作目录解析）",
        }),
      ),
      timeout_secs: Type.Optional(
        Type.Number({ description: `超时秒数（默认 ${DEFAULT_TIMEOUT_SECS}）` }),
      ),
    }),
    execute: async (args) => {
      const task = String(args.task ?? "").trim();
      if (!task) {
        return {
          content: [{ type: "text" as const, text: "dispatch_subagent: task 不能为空" }],
        };
      }
      const timeoutSecs = Number(args.timeout_secs) > 0 ? Number(args.timeout_secs) : DEFAULT_TIMEOUT_SECS;
      const cli = piCliPath();
      const cliArgs: string[] = [];
      const provider = args.provider ? String(args.provider) : "";
      const model = args.model ? String(args.model) : "";
      if (provider) cliArgs.push("--provider", provider);
      if (model) cliArgs.push("--model", model);
      cliArgs.push("--print", task);
      const images = Array.isArray(args.images) ? args.images.map(String).filter(Boolean) : [];
      for (const img of images) {
        // @ 文件参数：print mode 经 processFileArguments 读入（图片 → ImageContent）。
        cliArgs.push(img.startsWith("@") ? img : `@${img}`);
      }
      const startedAt = Date.now();
      const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
        execFile(
          process.execPath,
          [cli, ...cliArgs],
          {
            timeout: timeoutSecs * 1000,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
            // cwd = 主会话项目目录（扩展进程 cwd 即 pi 会话的工作目录——
            // 该目录的 trust 已在主会话建立，print mode 子进程不触发信任提示；
            // home 目录可能碰上无关 pi 项目资源反而误触发）。
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
      });
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const out = result.stdout.trim();
      if (!out) {
        const detail = result.stderr.trim().slice(0, 600);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `dispatch_subagent 失败（${elapsed}s，exit=${result.code}）` +
                (detail ? `：${detail}` : "（无输出——检查模型是否支持该任务/图片路径是否存在）"),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `[subagent ${model || "default-model"} · ${elapsed}s]\n${out}`,
          },
        ],
      };
    },
  });
}
