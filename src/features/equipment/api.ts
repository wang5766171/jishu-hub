// v0.9.8 需求5（合并版）：装备推荐——类型与数据访问。
// 装备统一 ref 语法：curated:<id> / skillhub:<slug> / pi:<source>。
// 官方件档案真源 = curated.json（market_list_curated）；第三方件 = equipment.db
// equipment_tags 表；前端 catalog = 两者合并视图（现场交叉算已装态）。

import { invokeCommand } from "@/hooks/use-invoke";

/** equipment_tags 行（第三方件标签库）。 */
export interface EquipmentTagRow {
  ref: string;
  title: string;
  tags: string[];
  stars: number;
  stars_basis: string;
  source: string;
  installed_at: number | null;
}

/** 任务画像（L2 产出 / L1 消费）。 */
export interface TaskProfile {
  session_id: string;
  scene: string;
  keywords: string[];
  updated_at: number;
}

/** 来源台账行（反馈信号）。 */
export interface EquipOriginRow {
  ref: string;
  via: string;
  at: number;
}

/** 装备推荐配置（六键；默认值 hub.rs 单源）。 */
export interface EquipConfig {
  enabled: boolean;
  session_card: boolean;
  session_limit: number;
  input_bar: boolean;
  market_zone: boolean;
  third_party: boolean;
}

/** 安装链 meta（via=推荐链路来源；title=第三方件友好名；tags=agent 理由标签）。 */
export interface InstallMeta {
  via?: string;
  title?: string;
  tags?: string[];
}

/** 合并目录条目（catalog：官方 curated + 第三方标签库）。 */
export interface CatalogEntry {
  ref: string;
  title: string;
  tags: string[];
  stars: number;
  /** curated 件的 kind（组合件/pi 包/官方智能体…）；第三方件 undefined。 */
  kind?: string;
  description?: string;
}

// ── 命令封装（薄层：失败回空/默认，不炸调用方） ──

export async function fetchEquipmentTags(): Promise<EquipmentTagRow[]> {
  try {
    const rows = await invokeCommand<EquipmentTagRow[]>("equipment_tags_list");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function upsertEquipmentTag(entry: {
  ref: string;
  title?: string;
  tags?: string[];
  stars?: number;
  source?: string;
}): Promise<void> {
  try {
    await invokeCommand("equipment_tag_upsert", entry);
  } catch {
    // 标签固化是旁路资产——失败静默（下次事件再补）。
  }
}

export async function fetchLatestProfile(): Promise<TaskProfile | null> {
  try {
    return (await invokeCommand<TaskProfile | null>("task_profile_latest")) ?? null;
  } catch {
    return null;
  }
}

export async function saveProfile(sessionId: string, scene: string, keywords: string[]): Promise<void> {
  try {
    await invokeCommand("task_profile_upsert", { sessionId, scene, keywords });
  } catch {
    // 画像落盘失败静默——推荐卡仍可渲染，L1 下次再补。
  }
}

export async function fetchRecommended(sessionId: string): Promise<string[]> {
  try {
    const rows = await invokeCommand<string[]>("equip_recommended_list", { sessionId });
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function fetchRecommendedCount(sessionId: string): Promise<number> {
  try {
    return (await invokeCommand<number>("equip_recommended_count", { sessionId })) ?? 0;
  } catch {
    return 0;
  }
}

export async function recordRecommended(sessionId: string, refs: string[]): Promise<void> {
  try {
    await invokeCommand("equip_recommended_add", { sessionId, refs });
  } catch {
    // 已推记忆失败静默（限次/防重是体验闸，非数据闸）。
  }
}

export async function fetchOrigins(): Promise<EquipOriginRow[]> {
  try {
    const rows = await invokeCommand<EquipOriginRow[]>("equip_origins_list");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function fetchEquipConfig(): Promise<EquipConfig> {
  try {
    return (
      (await invokeCommand<EquipConfig>("equip_config_get")) ?? {
        enabled: true,
        session_card: true,
        session_limit: 1,
        input_bar: true,
        market_zone: true,
        third_party: true,
      }
    );
  } catch {
    return {
      enabled: true,
      session_card: true,
      session_limit: 1,
      input_bar: true,
      market_zone: true,
      third_party: true,
    };
  }
}

export async function setEquipConfig(patch: Partial<EquipConfig>): Promise<void> {
  await invokeCommand("equip_config_set", {
    enabled: patch.enabled ?? null,
    sessionCard: patch.session_card ?? null,
    sessionLimit: patch.session_limit ?? null,
    inputBar: patch.input_bar ?? null,
    marketZone: patch.market_zone ?? null,
    thirdParty: patch.third_party ?? null,
  });
}
