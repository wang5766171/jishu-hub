/**
 * v0.9.4 需求7 测试期重构：steer 会话状态机（单一真源）。
 *
 * 重构前病灶（补丁四轮仍出双条/消失）：
 *  - 队列 / live 占位 / 暂存重发三份状态散落（event-pipeline 局部 + chat-page
 *    state + ref），清理靠各提交路径手工配对，漏配对即双条或消失；
 *  - 占位是独立 React state，与队列同步靠约定；
 *  - 停止链路时序：abort_chat 快速返回 → onAbort 先于 TurnComplete(Aborted)，
 *    任何抢先 drop 流都会让晚到的终结者被 pushTracked 拒绝 → 收口（重发）死。
 *
 * 重构后规则：
 *  1. queue（含占位元数据）是唯一真源；占位渲染 = queue 派生（slice 已注入数），
 *     独立占位 state 删除；
 *  2. 本类纯逻辑（无 React 依赖），变更后 bump 版本号通知渲染层订阅；
 *  3. turn_complete 是唯一回合终结者：consume（注入消费）/ takeResend（取走
 *     pi 作废的重发份）/ reset（Abort 清零）；onAbort 只做乐观提交 + 标记，
 *     不碰本状态机的终局语义。
 *
 * @invariant queue.length === placeholders 派生长度（占位即 queue 投影）
 */

export interface SteerQueueItem {
  /** 引导文本（用户原文，未展开——pi 侧展开差异由 reconcile 兜底吸收）。 */
  text: string;
  /** v0.9.0 需求3 方案 C：用户消息气泡的插件 pill 元数据。 */
  toolIds?: string[];
}

interface SteerSessionState {
  queue: SteerQueueItem[];
  /** 被 pi clear_queue 作废、等待 Abort 终结重发的文本（保持到达序）。 */
  pendingResend: string[];
}

type Listener = () => void;

export class SteerCoordinator {
  private sessions = new Map<string, SteerSessionState>();
  private listeners = new Set<Listener>();
  private version = 0;

  /** 渲染层订阅（useSyncExternalStore / 手动 bump 均可）。 */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private notify(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  private stateOf(key: string): SteerSessionState {
    let s = this.sessions.get(key);
    if (!s) {
      s = { queue: [], pendingResend: [] };
      this.sessions.set(key, s);
    }
    return s;
  }

  /** 登记一条引导（onGuideStaged：steer_chat 发出后调用）。 */
  stage(key: string, text: string, toolIds?: string[]): void {
    devLog("steer", "stage", { key, text: text.slice(0, 60), toolIds });
    const s = this.stateOf(key);
    s.queue.push({ text, toolIds });
    this.notify();
  }

  /**
   * 注入兑现（steer_injected 到达）：pi 已把该条从队转 turn 消息——按文本
   * 移除（匹配队首优先；展开变形时按最旧条目兜底）。占位随队列投影消失，
   * 与流内 steerTexts 的「已注入隐藏」双保险。
   */
  consumeInjected(key: string, text: string): void {
    devLog("steer", "consumeInjected", { key, text: text.slice(0, 60) });
    const s = this.sessions.get(key);
    if (!s || s.queue.length === 0) return;
    const idx = s.queue.findIndex((q) => q.text === text);
    const at = idx >= 0 ? idx : 0;
    s.queue.splice(at, 1);
    if (s.queue.length === 0 && s.pendingResend.length === 0) {
      this.sessions.delete(key);
    }
    this.notify();
  }

  /** 快照（渲染层派生占位用；勿持有引用后修改）。 */
  queueOf(key: string): readonly SteerQueueItem[] {
    return this.sessions.get(key)?.queue ?? [];
  }

  /** 文本快照（提交路径用）。 */
  textsOf(key: string): string[] {
    return this.stateOf(key).queue.map((i) => i.text);
  }

  /**
   * 消费前 `count` 条（已注入/已提交——mid-turn 交错与 FIFO 提交后调用）。
   * 队列与占位同源，不存在漏配对。
   */
  consume(key: string, count: number): void {
    if (count <= 0) return;
    const s = this.stateOf(key);
    s.queue = s.queue.slice(count);
    if (s.queue.length === 0 && s.pendingResend.length === 0) {
      this.sessions.delete(key);
    }
    this.notify();
  }

  /**
   * pi clear_queue 作废对账（steer_queue_cleared 事件）。
   * 返回分组结果；副作用：匹配移除的进 pendingResend（Abort 终结时经
   * takeResend 取走重发），followUp 交回调用方回填输入框。
   *
   * 兜底（测试期教训）：pi 入队前做 skill/模板展开，回传文本可能与原文
   * 不等 → 精确匹配失败。此时按事件条数移除最旧条目（占位即 queue 投影，
   * 自动消失，无僵尸）；事件条数 ≥ 队列长时全清。
   */
  reconcileCleared(
    key: string,
    texts: string[],
    followUpTexts: string[],
  ): { steering: string[]; followUps: string[] } {
    devLog("steer", "reconcileCleared", { key, texts: texts.length, followUps: followUpTexts.length });
    const steering = texts.filter((t) => !followUpTexts.includes(t));
    const s = this.sessions.get(key);
    if (!s || s.queue.length === 0) {
      // 队列已空（如 steer 已注入）：事件里的 steering 仍需重发登记。
      if (steering.length > 0) {
        const fresh = this.stateOf(key);
        fresh.pendingResend.push(...steering);
        this.notify();
      }
      return { steering, followUps: followUpTexts };
    }
    const toRemove = [...texts];
    const remaining = s.queue.filter((q) => {
      const i = toRemove.indexOf(q.text);
      if (i >= 0) {
        toRemove.splice(i, 1);
        return false;
      }
      return true;
    });
    const removed = s.queue.length - remaining.length;
    if (removed < texts.length) {
      // 匹配不全（展开变形）：按事件条数移除最旧条目，事件文本进重发。
      const shortfall = Math.min(texts.length - removed, remaining.length);
      remaining.splice(0, shortfall);
    }
    s.queue = remaining;
    if (texts.length > 0) {
      s.pendingResend.push(...steering);
    }
    if (s.queue.length === 0 && s.pendingResend.length === 0) {
      this.sessions.delete(key);
    }
    this.notify();
    return { steering, followUps: followUpTexts };
  }

  /**
   * 取走暂存重发（turn_complete(Aborted) 终结收口调用，一次性）。
   * 与队列残留（事件丢失兜底）由调用方合并处理。
   */
  takeResend(key: string): string[] {
    devLog("steer", "takeResend", { key });
    const s = this.sessions.get(key);
    if (!s || s.pendingResend.length === 0) return [];
    const out = s.pendingResend;
    s.pendingResend = [];
    if (s.queue.length === 0) this.sessions.delete(key);
    this.notify();
    return out;
  }

  /**
   * Abort 回合终结清零：pi 队列已被 clear_queue 作废，任何队列残留都是
   * 对账失败的僵尸（无重发意义——重发份已进 pendingResend / 已提交）。
   * 正常完成**不得**调用（多条引导第 2+ 条等 pi follow-up turn）。
   */
  resetAborted(key: string): void {
    devLog("steer", "resetAborted", { key });
    const s = this.sessions.get(key);
    if (!s) return;
    // pendingResend 保留：takeResend 与 reset 的调用顺序是「先取走再清零」，
    // 若收口路径异常未取走，保留待下回合（防御；正常路径已取空）。
    s.queue = [];
    if (s.pendingResend.length === 0) this.sessions.delete(key);
    this.notify();
  }

  isEmpty(key: string): boolean {
    const s = this.sessions.get(key);
    return !s || (s.queue.length === 0 && s.pendingResend.length === 0);
  }

  /** 会话 id 解析后的键迁移（pending → real id，事件管线 realId 分支）。 */
  moveKey(from: string, to: string): void {
    devLog("steer", "moveKey", { from, to });
    if (from === to) return;
    const s = this.sessions.get(from);
    if (!s) return;
    const existing = this.sessions.get(to);
    if (existing) {
      existing.queue.push(...s.queue);
      existing.pendingResend.push(...s.pendingResend);
    } else {
      this.sessions.set(to, s);
    }
    this.sessions.delete(from);
    this.notify();
  }

  /** 测试辅助：清空全部状态。 */
  clearAll(): void {
    this.sessions.clear();
    this.notify();
  }
}

import { devLog } from "@/lib/dev-log";

/** 全局单例（与 streamStore 同生命周期模式）。 */
export const steerCoordinator = new SteerCoordinator();
