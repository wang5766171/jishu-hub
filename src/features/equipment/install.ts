// v0.9.8 评审修复轮 R2（R2-7）：装一件装备的唯一出口。
//
// 调用方只说「装这个 ref」，安装结果只在这里判读：
//   - 已装（以执行时刻的台账为准）→ 不装，如实回报 already；
//   - 装成 → installed；
//   - 扩展工具撞名：后端回滚并返回 status="conflict"（没装上，等用户决断）
//     → 弹确认卡；确认 = 停用对手并安装，取消 = declined（保持未装）。
// 修前只有市场在线库卡片读返回值；执行器、npm 检索兜底卡、输入框建议条都不看
// 结果，撞名时照样打勾 / 弹装后引导卡 / 摘掉建议。现在所有安装路径都经这里
//（二轮评审 R3 又收进两处：精选单卡安装、新手引导安装步；插件中心的「还原钉版」
// 走下面的 reinstallRef——同一个结果判读，不做「已装就不装」的判定）。
// 后端不改：返回形状（tag=status）已满足需要。
//
// 二轮评审 R3（M 域）在本文件落实的四条：
//   P2-3  结果只认后端明确说的「装成」；别的一律按没装成报错，不再默认成功。
//   P2-7  抛出的错误就是可以直接显示的原因（中文；后端报错去掉机器前缀与
//         括号里的英文原文）——调用方拿去落行 / 上屏即可。
//   P2-8  同一件同一时刻只装一次：在途集合是模块级的，跨界面、跨组件实例
//         （弹层能关、页面能离开之后，「旧一轮还在途、新一轮又发起」是可达的）。
//   P2-14d 不认识的 ref 不再抛英文内部话。

import { useCallback } from "react";
import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { invokeCommand } from "@/hooks/use-invoke";
import { useConfirmDialog, type ConfirmDialogOptions } from "@/components/ui/confirm-dialog";
import { userFacingError } from "@/lib/user-facing-error";
import { fetchInstalledRefs, isInstalledRef, packageKeyOf, piRefOf } from "./installed";
import { installCommandFor } from "./match";
import type { InstallMeta } from "./api";

/** 工具撞名的一方（后端 PiConflictInfo，snake_case）。 */
export interface PiConflictView {
  tool: string;
  opponent_source: string;
  opponent_display: string;
  opponent_builtin: boolean;
}

/** 在线安装结果（后端 PiInstallOutcome，tag=status）。 */
export interface InstallOnlineOutcome {
  status: "installed" | "conflict";
  conflicts?: PiConflictView[];
}

export type InstallRefResult =
  /** 装成；stopped = 撞名确认后被停用的对手展示名（无撞名为空）。 */
  | { kind: "installed"; stopped: string[] }
  /** 执行时已装，没有重复安装。 */
  | { kind: "already" }
  /** 工具撞名且用户取消：保持未装。 */
  | { kind: "declined" };

/** 工具撞名时问用户：true = 停用对手并安装；false = 保持未装。 */
export type ConflictAsker = (display: string, conflicts: PiConflictView[]) => Promise<boolean>;

/** 出口的失败：没装成，message 就是可以直接显示的原因。 */
function installFailure(reason: unknown): Error {
  return new Error(userFacingError(reason));
}

/** 安装类命令：后端报错原样是给日志看的，出口交出去的已经是给用户看的文字。 */
async function callInstall<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invokeCommand<T>(command, args);
  } catch (e) {
    throw installFailure(e);
  }
}

// 在途安装（模块级）：ref 归一键 → 这一次安装的结果。后到的调用不另起一次，
// 等先到的结果——装成、撞名取消、失败，三者和先到的调用拿到的一样（这件的
// 真实结果只有一个）。
const inFlight = new Map<string, Promise<InstallRefResult>>();

/** 互斥键：同一件的不同写法（npm 源带不带版本、git 源带不带 https 前缀）算同一件。 */
function inFlightKeyOf(ref: string): string {
  return ref.startsWith("pi:") ? piRefOf(ref.slice("pi:".length)) : ref;
}

function oneAtATime(key: string, start: () => Promise<InstallRefResult>): Promise<InstallRefResult> {
  const running = inFlight.get(key);
  if (running) return running;
  const task = start();
  inFlight.set(key, task);
  // 落定即释放（成败都放）；表里还是这一次时才删——不误删后来的。
  const release = () => {
    if (inFlight.get(key) === task) inFlight.delete(key);
  };
  void task.then(release, release);
  return task;
}

/** 扩展展示名（确认卡标题用）：包名（npm 源去掉前缀与版本段——npm 检索兜底
 *  卡的源带版本号）；git 源取仓库名。 */
export function extensionDisplayName(source: string): string {
  return packageKeyOf(source).replace(/^npm:/, "").replace(/^git:.*\//, "");
}

/** 冲突确认卡——与市场在线库卡片同一份文案、同一个「停用并安装」问法。 */
export function askConflictDialog(
  confirm: (opts: ConfirmDialogOptions) => Promise<boolean>,
  t: TFunction,
  display: string,
  conflicts: PiConflictView[],
): Promise<boolean> {
  const items = conflicts
    .map((c) =>
      t("market.conflictItem", {
        defaultValue: "「{{opponent}}」（工具 {{tool}}）",
        opponent: c.opponent_display,
        tool: c.tool,
      }),
    )
    .join(t("common.listSeparator", "、"));
  return confirm({
    title: t("market.conflictTitle", { defaultValue: "能力重叠：{{name}}", name: display }),
    description: t("market.conflictDesc", {
      defaultValue:
        "该扩展与已装能力重叠：{{items}}。\n继续安装将停用上述扩展（内置项在卸载本扩展时自动恢复）；取消则不安装。",
      items,
    }),
    confirmText: t("market.conflictConfirm", "停用并安装"),
  });
}

/** 把确认卡接到当前组件上：ask 交给安装出口，dialogNode 由调用方渲染。 */
export function useConflictAsker(): { ask: ConflictAsker; dialogNode: ReactNode } {
  const { confirm, dialogNode } = useConfirmDialog();
  const { t } = useTranslation();
  const ask = useCallback(
    (display: string, conflicts: PiConflictView[]) => askConflictDialog(confirm, t, display, conflicts),
    [confirm, t],
  );
  return { ask, dialogNode };
}

async function installAndRead(
  ref: string,
  meta: InstallMeta | undefined,
  ask: ConflictAsker | undefined,
): Promise<InstallRefResult> {
  const target = installCommandFor(ref);
  if (!target) {
    // 不该发生（ref 来自目录 / 标签库 / 套装清单）：如实报没装，不抛英文内部话。
    throw installFailure(i18n.t("equip.installRefUnknown", { defaultValue: "无法识别这个安装项，本次未安装" }));
  }
  const args = { ...target.args, meta: meta ?? { via: "manual" } };
  if (!ref.startsWith("pi:")) {
    // 精选件 / 技能件：后端只回一句文字，或报错——报错即没装成。
    await callInstall(target.command, args);
    return { kind: "installed", stopped: [] };
  }
  const source = ref.slice("pi:".length);
  const outcome = await callInstall<InstallOnlineOutcome>(target.command, args);
  // 只认后端明确说的两种结果；别的一律按没装成报错（修前：不是 conflict 就算装成）。
  if (outcome?.status === "installed") return { kind: "installed", stopped: [] };
  if (outcome?.status !== "conflict") {
    throw installFailure(i18n.t("equip.installResultUnknown", { defaultValue: "安装结果无法确认，未记为已安装" }));
  }
  const go = ask ? await ask(extensionDisplayName(source), outcome.conflicts ?? []) : false;
  if (!go) return { kind: "declined" };
  // 确认后的安装与直接安装带同一份安装链信息（来源 / 标题 / 标签）——确认安装
  // 成功后走的是同一处登记，不带的话这件会被记成手动安装、没有标题标签。
  const confirmed = await callInstall<{ disabled?: unknown }>("pi_package_install_confirmed", {
    source,
    meta: args.meta,
  });
  if (!Array.isArray(confirmed?.disabled)) {
    throw installFailure(i18n.t("equip.installResultUnknown", { defaultValue: "安装结果无法确认，未记为已安装" }));
  }
  return {
    kind: "installed",
    stopped: confirmed.disabled.map((d) => (d as { opponent_display?: string } | null)?.opponent_display ?? "").filter(Boolean),
  };
}

/**
 * 装一件（curated:<id> / skillhub:<slug> / pi:<源写法>）。
 * 抛错 = 没装成，错误文字可直接显示（后端报错已去掉机器前缀与英文原文）。
 */
export function installRef(
  ref: string,
  meta?: InstallMeta,
  ask?: ConflictAsker,
): Promise<InstallRefResult> {
  return oneAtATime(inFlightKeyOf(ref), async () => {
    // 已装跳过：以执行时刻的台账为准——调用方渲染时看到的已装态可能已经过期
    //（会话推荐卡挂载后不刷新；已装的技能再装一次会整目录重写）。
    // 台账读不到、或读到的形状看不懂，同样不装：已装态不明不能当成「都没装」。
    const installed = await fetchInstalledRefs();
    if (!installed) {
      throw installFailure(i18n.t("equip.installedUnreadable", { defaultValue: "无法读取已安装清单，本次未安装" }));
    }
    if (isInstalledRef(installed, ref)) return { kind: "already" };
    return installAndRead(ref, meta, ask);
  });
}

/**
 * 已装的件按指定版本重装（插件中心「卸载更新 / 还原钉版」）。与 installRef 的
 * 区别只有一处：不做「已装就不装」的判定——这里的件本来就在，用户要的正是换回
 * 指定版本。结果判读、错误口径、在途互斥都走同一条路。只对 pi: 件开放
 *（技能 / 精选件的重装会整目录重写，不是这个入口的语义）。
 */
export function reinstallRef(
  ref: string,
  meta?: InstallMeta,
  ask?: ConflictAsker,
): Promise<InstallRefResult> {
  return oneAtATime(inFlightKeyOf(ref), async () => {
    if (!ref.startsWith("pi:")) {
      throw installFailure(i18n.t("equip.installRefUnknown", { defaultValue: "无法识别这个安装项，本次未安装" }));
    }
    return installAndRead(ref, meta, ask);
  });
}
