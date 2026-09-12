// v0.9.2 需求9 补丁五（用户裁决 2026-09-12）：模型参数模板库——独立于渠道
// 预设（provider-presets 按渠道绑死），**全渠道/全 agent 通用**的快速带参
// 模板，激活前/后添加与编辑模型共用。
//
// 模板集（用户指定 8 个）：
//   1M 上下文 ×2：推理 + 文本输入；其中一个支持图像输入、一个不支持。
//   256k 上下文 ×2：同上（推理 + 文本，一图像一非图像）。
// 全部保留**后 4 档思考强度**（high / xhigh / max + medium？——「后 4 档」
// 按 THINKING_LEVEL_ALL = off/minimal/low/medium/high/xhigh/max 的末四位
// = medium/high/xhigh/max；thinkingLevelMap 声明仅写与默认（off..high）
// 的差集：声明支持 xhigh/max，声明不支持 off/minimal/low）。

import { thinkingLevelMapFromSupported, type PiModelEntry } from "@/components/config/model-types";

export interface ModelParamTemplate {
  id: string;
  displayName: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: true;
  inputText: true;
  inputImage: boolean;
  /** 后 4 档思考强度（medium/high/xhigh/max）。 */
  thinkingLevels: string[];
}

/** 后 4 档（THINKING_LEVEL_ALL 末四位）。 */
const LAST_4_LEVELS = ["medium", "high", "xhigh", "max"];

function template(
  id: string,
  displayName: string,
  contextWindow: number,
  inputImage: boolean,
): ModelParamTemplate {
  return {
    id,
    displayName,
    contextWindow,
    maxTokens: Math.round(contextWindow / 8),
    reasoning: true,
    inputText: true,
    inputImage,
    thinkingLevels: LAST_4_LEVELS,
  };
}

/** 全渠道通用模板（用户指定 8 个）。 */
export const MODEL_PARAM_TEMPLATES: ModelParamTemplate[] = [
  template("tmpl-1m-vision", "1M 上下文 · 推理 · 图像输入", 1_000_000, true),
  template("tmpl-1m-text", "1M 上下文 · 推理 · 纯文本", 1_000_000, false),
  template("tmpl-256k-vision", "256k 上下文 · 推理 · 图像输入", 256_000, true),
  template("tmpl-256k-text", "256k 上下文 · 推理 · 纯文本", 256_000, false),
];

/** 模板 → 完整模型条目（id 由用户填，模板只带参数）。 */
export function templateToModelEntry(templateId: string, modelId: string): PiModelEntry | null {
  const t = MODEL_PARAM_TEMPLATES.find((x) => x.id === templateId);
  if (!t) return null;
  const input: string[] = ["text"];
  if (t.inputImage) input.push("image");
  const entry: PiModelEntry = {
    id: modelId,
    name: modelId,
    input,
    reasoning: t.reasoning,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: t.contextWindow,
    maxTokens: t.maxTokens,
  };
  const map = thinkingLevelMapFromSupported(t.thinkingLevels);
  if (map) entry.thinkingLevelMap = map;
  return entry;
}
