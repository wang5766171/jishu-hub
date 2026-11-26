// v0.9.8 评审修复轮 R2（R2-6）：已装集——「这件装备装了没有」的唯一构造处。
//
// 装没装只由三份后端台账决定，各对应一种 ref 前缀：
//   plugin_list                   → curated:<id>      hub 插件清单
//   skillhub_installed            → skillhub:<slug>   技能市场安装台账
//   pi_package_installed_sources  → pi:<源写法>       扩展包注册串
// 修前市场页把三份台账拆成三个状态、各只在一个页签的 load() 里刷新（套装弹层
// 所在的精选页签上，技能 / 扩展两份恒为空），推荐卡与输入框建议条又各手写一份
// 归一。现在读取与归一只在这里，各处同一份判定。

import { invokeCommand } from "@/hooks/use-invoke";
import { devLog } from "@/lib/dev-log";

/** 三份台账的原样内容（市场页存这一份，其余视图都从它派生）。 */
export interface InstalledLedgers {
  /** hub 插件清单里的插件 id（技能市场装进来的技能件也在其中，按各自 id）。 */
  pluginIds: string[];
  /** 技能市场安装台账：slug → 版本。 */
  skills: Record<string, string>;
  /** 扩展包注册串原样（npm 源带版本，如 npm:pkg@1.0.0）。 */
  piSources: string[];
}

/** npm 注册串去掉版本段（scoped 包的 @scope 不是版本分隔；不带版本的原样）。 */
function npmKeyOf(source: string): string {
  const rest = source.slice("npm:".length);
  const m = rest.match(/^(@[^/]+\/[^@]+|[^@]+)@.*$/);
  return "npm:" + (m ? m[1] : rest);
}

/** 注册串 → 无版本键（登记簿 pkg_key 同一规则；非 npm 源原样）。 */
export function packageKeyOf(source: string): string {
  return source.startsWith("npm:") ? npmKeyOf(source) : source;
}

/** 扩展注册串在 ref 里的源写法：npm 去版本段；git 源落盘可能带 https:// 前缀
 * （安装命令尾段不带）——归一成一种写法，带不带前缀算同一件。 */
export function piRefOf(source: string): string {
  const key = source.startsWith("npm:")
    ? npmKeyOf(source)
    : source.replace(/^git:https?:\/\//, "git:");
  return `pi:${key}`;
}

/** 三份台账 → 已装集。 */
export function buildInstalledRefs(ledgers: InstalledLedgers): Set<string> {
  const refs = new Set<string>();
  for (const id of ledgers.pluginIds) refs.add(`curated:${id}`);
  for (const slug of Object.keys(ledgers.skills)) refs.add(`skillhub:${slug}`);
  for (const src of ledgers.piSources) refs.add(piRefOf(src));
  return refs;
}

/** 已装判定。pi 源写法先归一再比：ref 里带版本或带 https 前缀也认。 */
export function isInstalledRef(installed: Set<string>, ref: string): boolean {
  return installed.has(ref.startsWith("pi:") ? piRefOf(ref.slice("pi:".length)) : ref);
}

/** 两份台账内容是否相同（与顺序无关）。 */
export function sameInstalledLedgers(a: InstalledLedgers | null, b: InstalledLedgers | null): boolean {
  if (!a || !b) return a === b;
  return (
    sameMembers(a.pluginIds, b.pluginIds) &&
    sameMembers(a.piSources, b.piSources) &&
    sameMembers(Object.keys(a.skills), Object.keys(b.skills)) &&
    Object.keys(a.skills).every((slug) => a.skills[slug] === b.skills[slug])
  );
}

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 二轮评审 R3（P2-4a）：「读到了但看不懂」与「读不到」同一条路。修前三份台账
// 形状不合预期时按空处理——已装态不明被当成「确实没有」，执行前判定会放行。

/** 插件清单 → 插件 id；没有清单、清单不是数组、项缺 id → null。 */
function pluginIdsOf(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.plugins)) return null;
  const ids: string[] = [];
  for (const p of value.plugins) {
    if (!isRecord(p) || typeof p.id !== "string") return null;
    ids.push(p.id);
  }
  return ids;
}

/** 技能台账 → slug → 版本；不是对象、版本不是字符串 → null。 */
function skillsOf(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  for (const v of Object.values(value)) {
    if (typeof v !== "string") return null;
  }
  return value as Record<string, string>;
}

/** 字符串数组；不是数组、含非字符串 → null。 */
function stringListOf(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : null;
}

/** 读三份台账。任一份读不到、或读到的形状看不懂，返回 null——已装态不明时
 * 调用方不得把它当成「都没装」：推荐方不推荐，安装方不安装，展示方给
 * 「状态未知」。 */
export async function fetchInstalledLedgers(): Promise<InstalledLedgers | null> {
  try {
    const [plugins, skills, piSources] = await Promise.all([
      invokeCommand<unknown>("plugin_list"),
      invokeCommand<unknown>("skillhub_installed"),
      invokeCommand<unknown>("pi_package_installed_sources"),
    ]);
    const pluginIds = pluginIdsOf(plugins);
    const skillLedger = skillsOf(skills);
    const sources = stringListOf(piSources);
    if (!pluginIds || !skillLedger || !sources) {
      devLog("ipc", "已装台账形状不合预期（按读不到处理）", { plugins, skills, piSources });
      return null;
    }
    return { pluginIds, skills: skillLedger, piSources: sources };
  } catch (e) {
    devLog("ipc", "已装台账读取失败（plugin_list / skillhub_installed / pi_package_installed_sources）", {
      error: String(e),
    });
    return null;
  }
}

/** 读三份台账并归一成已装集；读不到返回 null（同上）。 */
export async function fetchInstalledRefs(): Promise<Set<string> | null> {
  const ledgers = await fetchInstalledLedgers();
  return ledgers ? buildInstalledRefs(ledgers) : null;
}

/**
 * 只读已装扩展的注册串（插件中心的扩展包页签用）。读不到返回 null——
 * 「读不到」不等于「一个都没装」：调用方保留上一次的清单并标出读取失败，
 * 不得把 null 当空清单写成「暂无扩展包」。
 */
export async function fetchInstalledExtensionSources(): Promise<string[] | null> {
  try {
    const sources = stringListOf(await invokeCommand<unknown>("pi_package_installed_sources"));
    if (!sources) devLog("ipc", "已装扩展清单形状不合预期（按读不到处理）");
    return sources;
  } catch (e) {
    devLog("ipc", "已装扩展清单读取失败（pi_package_installed_sources）", { error: String(e) });
    return null;
  }
}

/**
 * 只读技能台账（插件中心的技能卡用它判已装与可更新）。读不到返回 null——后端
 * 读不了或解析不了台账文件会报错（文件不存在才是空台账），调用方保留上一次
 * 读到的并标出读取失败，不得把 null 当成「一个技能都没装」。
 */
export async function fetchInstalledSkillLedger(): Promise<Record<string, string> | null> {
  try {
    const ledger = skillsOf(await invokeCommand<unknown>("skillhub_installed"));
    if (!ledger) devLog("ipc", "技能台账形状不合预期（按读不到处理）");
    return ledger;
  } catch (e) {
    devLog("ipc", "技能台账读取失败（skillhub_installed）", { error: String(e) });
    return null;
  }
}
