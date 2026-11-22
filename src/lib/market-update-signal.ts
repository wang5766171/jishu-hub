/**
 * v0.9.8 需求8 D8-1 L2：市场目录更新红点信号（内存态，无落盘）。
 *
 * 语义：用户不在市场页时，后台预拉取（piindex-updated，changed 才 emit）
 * 到达 → 「插件市场」入口亮红点；进入市场页即清。市场页开着时事件由页内
 * 横幅承接（D8-1 另一半），不置红点。
 *
 * 实现注：订阅由 app 入口显式启动（startMarketUpdateSignal）——懒加载模块的
 * 副作用订阅会错过启动预拉取的一次性事件；vitest 等非 Tauri 环境失败静默。
 */
import { listen } from "@tauri-apps/api/event";

let updated = false;
let marketOpen = false;
let started = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** 市场面板挂载/卸载时置位——开着时事件走页内横幅；进入即清红点。 */
export function setMarketOpen(open: boolean): void {
  marketOpen = open;
  if (open && updated) {
    updated = false;
    notify();
  }
}

export function isMarketUpdated(): boolean {
  return updated;
}

/** @internal 仅测试重置模块态（vitest 文件间共享单例）。 */
export function __resetForTest(): void {
  updated = false;
  marketOpen = false;
}

export function subscribeMarketUpdate(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** app 入口显式启动（幂等）——signal store 走懒加载链（plugins-page
 * import），模块副作用订阅在启动预拉取 emit 之后才注册=永远错过一次性
 * 事件（dev 端到端实测暴露）；订阅必须挂 app 主链。 */
export function startMarketUpdateSignal(): void {
  if (started) return;
  started = true;
  void listen("piindex-updated", () => {
    if (marketOpen) return;
    updated = true;
    notify();
  }).catch(() => {
    // 非 Tauri 环境（vitest）——静默，信号源不存在。
  });
}
