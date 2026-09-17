/**
 * 阶段流水线基座（v0.9.3 需求13 C4-slice-1：编排能力契约层）。
 *
 * 三段式（discuss→plan→execute）泛化为「阶段流水线」：manifest [pipeline]
 * 声明阶段序列，每阶段可引用内置阶段模板（核心能力复用——视频生成例的
 * 「需求讨论」段即 phase.discuss 模板）+ 定制（提示词/技能/工具组/门禁/
 * 产出协议）。运行时驱动（conductor 阶段机数据化）为 C4-slice-2。
 */

/** 内置阶段模板键（核心能力，可被组合插件的阶段引用展开）。 */
export type StageTemplateKey = "phase.discuss" | "phase.plan" | "phase.execute" | "phase.review";

export interface StageTemplate {
  key: StageTemplateKey;
  name: string;
  description: string;
  /** 阶段提示词基座（引用方的 prompt 追加/覆盖）。 */
  prompt: string;
  /** 阶段可用技能（技能包名；空=不挂技能）。 */
  skills: string[];
  /** 阶段允许的工具面（收窄语义；空=不收窄）。 */
  tools: string[];
  /** 门禁：阶段推进前的人工确认。 */
  gate: "none" | "confirm";
  /** 产出协议（文档/方案/产物——产出物校验与下游衔接的键）。 */
  outputs: Array<{ kind: "document" | "plan" | "artifact" }>;
}

export const STAGE_TEMPLATES: Record<StageTemplateKey, StageTemplate> = {
  "phase.discuss": {
    key: "phase.discuss",
    name: "需求讨论",
    description: "结构化问答收敛需求，产出需求文档（lock_requirement 落定）",
    prompt: "与用户澄清目标/范围/约束，收敛为可执行的需求文档；未澄清前不进入下一阶段。",
    skills: ["jishu-conductor-dev:discuss"],
    tools: ["read", "grep", "find", "ls", "lock_requirement", "request_user_input"],
    gate: "confirm",
    outputs: [{ kind: "document" }],
  },
  "phase.plan": {
    key: "phase.plan",
    name: "流程规划",
    description: "拆分执行节点与依赖（flow-plan），产出方案图",
    prompt: "将需求拆分为有依赖关系的执行节点，产出 flow-plan；简单任务建议直接执行。",
    skills: ["jishu-conductor-dev:plan"],
    tools: ["read", "grep", "find", "ls", "commit_plan", "request_user_input"],
    gate: "confirm",
    outputs: [{ kind: "plan" }],
  },
  "phase.execute": {
    key: "phase.execute",
    name: "执行",
    description: "按方案图调度节点会话执行（含方案修订）",
    prompt: "按既定方案执行节点；阻塞/失败按重试与跳过策略处理，方案变更走修订。",
    skills: ["jishu-conductor-dev:execute"],
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "commit_plan", "dispatch_to_node"],
    gate: "none",
    outputs: [{ kind: "artifact" }],
  },
  "phase.review": {
    key: "phase.review",
    name: "评审确认",
    description: "产出物人工评审门禁（确认/打回）",
    prompt: "汇总产出请用户评审；通过则收尾，打回则回到指定阶段。",
    skills: [],
    tools: ["read", "grep", "find", "ls", "request_user_input"],
    gate: "confirm",
    outputs: [],
  },
};

/** manifest 阶段声明（模板引用或全自定义）。 */
export interface StageDeclaration {
  key?: string;
  name?: string;
  template?: StageTemplateKey;
  prompt?: string;
  skills?: string[];
  tools?: string[];
  gate?: "none" | "confirm";
  outputs?: Array<{ kind: "document" | "plan" | "artifact" }>;
}

export interface PipelineDeclaration {
  stages: StageDeclaration[];
}

/** 展开后的具体阶段（模板默认 ⨯ 声明覆盖——引擎与 UI 消费的最终形状）。 */
export interface ResolvedStage {
  key: string;
  name: string;
  template?: StageTemplateKey;
  prompt: string;
  skills: string[];
  tools: string[];
  gate: "none" | "confirm";
  outputs: Array<{ kind: "document" | "plan" | "artifact" }>;
}

/** 声明展开：模板默认值 + 声明覆盖（prompt 拼接、列表替换、gate/outputs 覆盖）。 */
export function resolveStages(decl: PipelineDeclaration): ResolvedStage[] {
  return (decl.stages ?? []).map((stage, index) => {
    const template = stage.template ? STAGE_TEMPLATES[stage.template] : undefined;
    if (stage.template && !template) {
      throw new Error(`阶段 ${index + 1} 引用了未知模板: ${stage.template}`);
    }
    return {
      key: stage.key ?? stage.template ?? `stage-${index + 1}`,
      name: stage.name ?? template?.name ?? `阶段 ${index + 1}`,
      template: stage.template,
      prompt: [template?.prompt, stage.prompt].filter(Boolean).join("\n"),
      skills: stage.skills ?? template?.skills ?? [],
      tools: stage.tools ?? template?.tools ?? [],
      gate: stage.gate ?? template?.gate ?? "none",
      outputs: stage.outputs ?? template?.outputs ?? [],
    };
  });
}

/** 流水线校验：至少一阶段；key 唯一；模板键存在；门禁值合法。 */
export function validatePipeline(decl: PipelineDeclaration | undefined): string[] {
  if (!decl) return [];
  const errors: string[] = [];
  if (!Array.isArray(decl.stages) || decl.stages.length === 0) {
    return ["[pipeline] 至少需要一个阶段"];
  }
  const seen = new Set<string>();
  decl.stages.forEach((stage, index) => {
    const label = `阶段 ${index + 1}`;
    if (stage.template && !(stage.template in STAGE_TEMPLATES)) {
      errors.push(`${label} 模板不存在: ${stage.template}`);
    }
    const key = stage.key ?? stage.template ?? `stage-${index + 1}`;
    if (seen.has(key)) errors.push(`${label} key 重复: ${key}`);
    seen.add(key);
    if (stage.gate && stage.gate !== "none" && stage.gate !== "confirm") {
      errors.push(`${label} gate 非法: ${stage.gate}`);
    }
    if (!stage.template && !stage.name && !stage.prompt) {
      errors.push(`${label} 既无模板也无名称/提示词（空阶段）`);
    }
  });
  return errors;
}
