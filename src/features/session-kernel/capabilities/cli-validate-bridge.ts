/**
 * CLI plugins validate 跨进程校验桥（v0.9.5 需求1（原需求26）1c）。
 *
 * 场景：`jishu-cli plugins validate <目录>` 在终端做插件清单校验——基础
 * 结构检查由 CLI（Rust）完成；完整校验（渲染臂字段/配对矩阵/流水线契约）
 * 必须复用 hub 前端的 TS 校验器（validateManifest / validatePipeline——与
 * GUI 向导同一份实现，单一校验真源，评审 P0-4）。
 *
 * 协议（标记文件信箱，同 .pending-confirm 模式）：CLI 写
 * `.cli-validate-req.json`（manifest JSON + componentJs 源码自包含，前端
 * 零任意路径访问）→ 本桥轮询 cli_validate_poll 发现请求 → 跑校验器 →
 * cli_validate_submit 回写 `.cli-validate-resp.json` → CLI 匹配 nonce 取
 * 结果（hub 未运行时 CLI 超时降级为基础校验）。
 */
import { useEffect } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { validateManifest, type SessionComposedManifest } from "./types";
import { validatePipeline } from "./pipeline/contracts";
import { rendererRegistry } from "./renderers/registry";

interface ValidateRequest {
  nonce: number;
  dir: string;
  manifest: unknown;
  componentJs?: string | null;
}

/** 轮询间隔：CLI 侧等待 12s（24×500ms），2.5s 间隔保证至少 4 次采样。 */
const POLL_INTERVAL_MS = 2500;

/** 对单个 CLI validate 请求跑 hub 侧校验器（导出供单测直接消费）。 */
export function runHubValidation(req: ValidateRequest): { valid: boolean; errors: string[] } {
  const manifest = req.manifest as SessionComposedManifest;
  const errors: string[] = [];
  // 1a 语义：pipeline 臂先校；validateManifest 无条件调用——其内部按
  // 「是否声明渲染臂」门控字段校验，并含「至少一臂」总校验（空清单拒绝
  // ——与 engine.buildComposedDescriptor 同模式）。
  if (manifest.pipeline) {
    errors.push(...validatePipeline(manifest.pipeline));
  }
  errors.push(
    ...validateManifest(manifest, rendererRegistry, {
      // componentJs 由 CLI 随请求附带（源码自包含）；@file: 组件就绪位
      // 以其存在为准（语法/契约细节 CLI 基础校验已做）。
      fileComponentReady: typeof req.componentJs === "string",
    }),
  );
  return { valid: errors.length === 0, errors };
}

/** 挂载于应用根（确认卡同区域）：轮询 CLI 校验请求并回写结果。 */
export function useCliValidateBridge(): void {
  useEffect(() => {
    let handling = false;
    const timer = window.setInterval(() => {
      if (handling) return;
      handling = true;
      void (async () => {
        try {
          const req = await invokeCommand<ValidateRequest | unknown>("cli_validate_poll");
          if (!req || typeof req !== "object" || !("nonce" in req)) return;
          const typed = req as ValidateRequest;
          if (typeof typed.nonce !== "number") return;
          const result = runHubValidation(typed);
          await invokeCommand("cli_validate_submit", {
            response: {
              nonce: typed.nonce,
              valid: result.valid,
              errors: result.errors,
            },
          });
        } catch {
          // 命令不存在（老后端）或 IO 错误——静默（CLI 侧超时降级兜底）
        } finally {
          handling = false;
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
}
