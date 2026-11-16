/**
 * v0.9.7 需求3 C4 / 需求4：场景分类唯一数据源（前端）。
 *
 * 三处共用：首启引导场景卡（需求4）/ 插件市场场景筛选（curated.json 的
 * scenes[] 用同一组 id）/ 技能市场分组（skillhubCategory 映射到 SkillHub
 * category，与后端 skillhub.rs 同表）。
 * 依据：docs/v0.9.7/场景分类与插件推荐.md §1/§2（6 场景 + 自定义）。
 */

export interface PluginScene {
  id: string;
  /** i18n 键（scenes.<id>，zh/en 均已登记） */
  nameKey: string;
  /** SkillHub category（null = 自定义/无对应分组） */
  skillhubCategory: string | null;
}

export const PLUGIN_SCENES: PluginScene[] = [
  { id: "programming", nameKey: "scenes.programming", skillhubCategory: "dev-programming" },
  { id: "office", nameKey: "scenes.office", skillhubCategory: "office-efficiency" },
  { id: "education", nameKey: "scenes.education", skillhubCategory: "education" },
  { id: "video", nameKey: "scenes.video", skillhubCategory: "design-media" },
  { id: "data", nameKey: "scenes.data", skillhubCategory: "data-analysis" },
  { id: "content", nameKey: "scenes.content", skillhubCategory: "content-creation" },
  { id: "custom", nameKey: "scenes.custom", skillhubCategory: null },
];

/** 场景 id 合法性（curated scenes[] 校验 / 引导页提交值校验）。 */
export function isValidSceneId(id: string): boolean {
  return PLUGIN_SCENES.some((s) => s.id === id);
}

/** 场景 id → SkillHub category（前端技能市场分组直查，避免再起一次 IPC）。 */
export function skillhubCategoryForScene(id: string): string | null {
  return PLUGIN_SCENES.find((s) => s.id === id)?.skillhubCategory ?? null;
}
