// v0.7.4：opencode 模型推荐目录（模型设置页当前模型大卡 + small model 下拉
// 数据源）。opencode 的模型 ID 为 `provider/model` 形式（官方 models 文档）；
// 由 ConfigSurface.model_catalog = "opencode" 声明启用（adapter 驱动）。
// 目录值均可被自由输入覆盖；新模型未收录时直接手输即可。

/** 自定义供应商新建时的默认 npm 适配器（opencode 生态知识，v0.7.4 审查 A6：
 *  从 opencode-providers 组件移入数据层，与目录同文件归口）。 */
export const OPENCODE_DEFAULT_PROVIDER_NPM = "@ai-sdk/openai-compatible";

export interface OpencodeModelOption {
  value: string;
  /** i18n key（config.opencodeModel.<key>） */
  labelKey: string;
}

export const OPENCODE_MODEL_CATALOG: OpencodeModelOption[] = [
  {
    value: "zhipuai-coding-plan/glm-5.1",
    labelKey: "config.opencodeModel.glm51",
  },
  {
    value: "opencode/gpt-5.1-codex",
    labelKey: "config.opencodeModel.gpt51codex",
  },
  {
    value: "anthropic/claude-sonnet-4-20250514",
    labelKey: "config.opencodeModel.sonnet4",
  },
  {
    value: "openai/gpt-5.1",
    labelKey: "config.opencodeModel.gpt51",
  },
];
