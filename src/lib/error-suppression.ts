/**
 * 全局错误抑制窗口（需求25 用户架构裁决）：
 * 全局 window.onerror 处理器是**兜底**——具体子系统（混合插件运行时等）
 * 在处理已知来源的错误期间"认领"错误并打开抑制窗口，全局处理器看到
 * 窗口开着就跳过；窗口关闭后全局处理器恢复兜底职责。
 *
 * 这不是过滤特定错误模式（脆弱），而是尊重具体处理器的优先权：
 * 具体处理器 > 全局兜底。
 */

let suppressed = 0;

/** 打开/关闭抑制窗口（支持嵌套：多子系统并发时计数归零才真正恢复）。 */
export function setErrorSuppression(active: boolean): void {
  suppressed = Math.max(0, suppressed + (active ? 1 : -1));
}

/** 全局处理器查询：是否有子系统正在处理错误。 */
export function isSuppressed(): boolean {
  return suppressed > 0;
}
