import type {
  PluginMessage,
  PluginSessionMeta,
  PluginStreamState,
  Unsubscribe,
} from "../plugins/types";
import type { TurnSummary } from "../view-model";

/**
 * 会话内核数据枢纽（v0.9.3 需求3 / P1-3，M1 事件管线先导块）。
 *
 * 各数据面（messages / streamState / sessionMeta / turns）监听器集合与最新
 * 快照的宿主：内核在数据变更时 publish（逐个回调订阅者），订阅时回放当前
 * 快照，退订真实移除。ctx（SessionKernelContext.subscribe）只是它的视图——
 * ctx 随 React 状态重建，数据面身份由本枢纽持有，订阅不随 ctx 重建而丢失。
 * v0.9.2 的「一次性快照假订阅」（cb 调一次即返回 no-op 退订）自此删除。
 *
 * 演进定位：M1 事件管线拆解（agent-event → store → 视图模型归并）时，本
 * 模块成为事件管线的订阅分发层，chat-page 只保留事件监听与 publish 调用。
 * 无 React 依赖（可在内核/worker 复用）；events 信号通道不经此（signals.ts
 * 独立总线，本就是真订阅）。
 */
/** 审批面投影（需求10 A4：插件可消费的待审批请求——最小字段）。 */
export interface PluginApprovalInfo {
  sessionId: string;
  requestId: string;
  kind: string;
}

export class SessionDataHub {
  private readonly messagesListeners = new Set<(msgs: PluginMessage[]) => void>();
  private readonly streamStateListeners = new Set<(state: PluginStreamState | null) => void>();
  private readonly sessionMetaListeners = new Set<(meta: PluginSessionMeta) => void>();
  private readonly turnsListeners = new Set<(turns: TurnSummary[]) => void>();
  private readonly approvalsListeners = new Set<(list: PluginApprovalInfo[]) => void>();

  private snapshots: {
    messages: PluginMessage[];
    streamState: PluginStreamState | null;
    sessionMeta: PluginSessionMeta | null;
    turns: TurnSummary[];
    approvals: PluginApprovalInfo[];
  } = {
    messages: [],
    streamState: null,
    sessionMeta: null,
    turns: [],
    approvals: [],
  };

  /** 订阅注册期的快照回放（与 publish 同款容错：单个订阅者抛错不阻断）。 */
  private replaySafely(replay: () => void): void {
    try {
      replay();
    } catch (error) {
      console.warn("session data hub: subscribe replay failed:", error);
    }
  }

  /** 用内核当前值刷新快照（不通知订阅者）。ctx 构造时调用——晚订阅者立即
   *  回放到的是最新数据，而非上一次 publish 的旧值。幂等，可重复调用。 */
  seed(snapshots: {
    messages?: PluginMessage[];
    streamState?: PluginStreamState | null;
    sessionMeta?: PluginSessionMeta | null;
    turns?: TurnSummary[];
    approvals?: PluginApprovalInfo[];
  }): void {
    this.snapshots = { ...this.snapshots, ...snapshots };
  }

  publishMessages(msgs: PluginMessage[]): void {
    this.snapshots.messages = msgs;
    for (const cb of this.messagesListeners) {
      try {
        cb(msgs);
      } catch (error) {
        console.warn("session data hub: messages listener failed:", error);
      }
    }
  }

  publishStreamState(state: PluginStreamState | null): void {
    this.snapshots.streamState = state;
    for (const cb of this.streamStateListeners) {
      try {
        cb(state);
      } catch (error) {
        console.warn("session data hub: streamState listener failed:", error);
      }
    }
  }

  publishSessionMeta(meta: PluginSessionMeta): void {
    this.snapshots.sessionMeta = meta;
    for (const cb of this.sessionMetaListeners) {
      try {
        cb(meta);
      } catch (error) {
        console.warn("session data hub: sessionMeta listener failed:", error);
      }
    }
  }

  publishTurns(turns: TurnSummary[]): void {
    this.snapshots.turns = turns;
    for (const cb of this.turnsListeners) {
      try {
        cb(turns);
      } catch (error) {
        console.warn("session data hub: turns listener failed:", error);
      }
    }
  }

  /** v0.9.3 需求10 A4 × 需求13 C4 融合：审批面——插件（审批中心类组合插件）
   *  可消费的待审批请求投影。 */
  publishApprovals(list: PluginApprovalInfo[]): void {
    this.snapshots.approvals = list;
    for (const cb of this.approvalsListeners) {
      try {
        cb(list);
      } catch (error) {
        console.warn("session data hub: approvals listener failed:", error);
      }
    }
  }

  subscribeApprovals(cb: (list: PluginApprovalInfo[]) => void): Unsubscribe {
    this.replaySafely(() => cb(this.snapshots.approvals));
    this.approvalsListeners.add(cb);
    return () => {
      this.approvalsListeners.delete(cb);
    };
  }

  /** 订阅：注册即回放当前快照；返回真实退订（再次移除后不再收 publish）。 */
  subscribeMessages(cb: (msgs: PluginMessage[]) => void): Unsubscribe {
    this.replaySafely(() => cb(this.snapshots.messages));
    this.messagesListeners.add(cb);
    return () => {
      this.messagesListeners.delete(cb);
    };
  }

  subscribeStreamState(cb: (state: PluginStreamState | null) => void): Unsubscribe {
    this.replaySafely(() => cb(this.snapshots.streamState));
    this.streamStateListeners.add(cb);
    return () => {
      this.streamStateListeners.delete(cb);
    };
  }

  subscribeSessionMeta(cb: (meta: PluginSessionMeta) => void): Unsubscribe {
    if (this.snapshots.sessionMeta) {
      const meta = this.snapshots.sessionMeta;
      this.replaySafely(() => cb(meta));
    }
    this.sessionMetaListeners.add(cb);
    return () => {
      this.sessionMetaListeners.delete(cb);
    };
  }

  subscribeTurns(cb: (turns: TurnSummary[]) => void): Unsubscribe {
    this.replaySafely(() => cb(this.snapshots.turns));
    this.turnsListeners.add(cb);
    return () => {
      this.turnsListeners.delete(cb);
    };
  }
}
