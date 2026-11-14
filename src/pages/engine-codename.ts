/** 评审 P1-12 修复（§7 引擎代号不暴露）：核心引擎卡描述来自后端内置对照表
 * （plugin.rs 含「Pi 引擎」字样；后端并行改数据源）——展示面兜底泛化，
 * 防旧缓存/回放数据泄漏。
 * 修复轮回归收口（评审 P2-4）：从 plugins-page 抽出独立 util——此前 modal
 * 反向 import plugins-page 形成循环依赖，破坏 modal 头部「避免循环依赖」
 * 的自我约束。 */
export function generalizeEngineCodename(desc: string): string {
  return desc.replace(/内嵌 ?Pi 引擎/g, "内嵌引擎").replace(/Pi 引擎/g, "引擎");
}
