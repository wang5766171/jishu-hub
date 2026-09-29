/**
 * 需求25 P2：混合插件安装确认卡（安全阀）。
 *
 * 场景：agent（jishu agent）在会话内写好 plugin.toml + component.js，
 * 经 `jishu-cli plugins add-hybrid <目录>` 安装落盘（或手工放置）后，
 * hub 前端检测到新装的混合插件 → 弹出确认卡展示关键信息（名称/挂载点/
 * 代码行数/文件路径）→ 用户点「启用」→ plugin_set_enabled(true) 生效；
 * 点「暂不」→ 保持禁用（不注入 script）。
 *
 * 输入源：hub 内部命令 plugin_confirm_pending（读取后端记录的待确认列表）。
 */
import { useCallback, useEffect, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { ShieldAlert, Check, X } from "lucide-react";
import { UniModal } from "@/components/ui/uni-modal";
// 5a（v0.9.5 需求1，原需敆26）：安装后自动展示——面板自动展开/挂件高亮/
// 测试通知，复用既有面板激活性与动作命令链。
import { requestPanelActivation } from "@/features/session-kernel/shell/panel-activation";
import { requestInstallSpotlight } from "@/features/session-kernel/shell/install-spotlight";

interface PendingHybridPlugin {
  /** 插件 id（session.xxx）。 */
  id: string;
  /** 显示名。 */
  name: string;
  /** 挂载点描述。 */
  mount: string;
  /** 代码文件行数。 */
  codeLines: number;
  /** 插件目录绝对路径。 */
  dir: string;
}

/** 轮询间隔：安装后 CLI 侧即时广播 plugins-changed 但确认卡需要额外数据，
 *  每 5s 刷新一次（轻量——后端在无待确认项时返回空数组）。 */
const POLL_INTERVAL_MS = 5000;

/** 5a：启用后自动展示（按 pending.mount 分派）。 */
function afterEnableShowcase(item: PendingHybridPlugin): void {
  switch (item.mount) {
    case "dock-panel":
    case "sidebar-panel":
      // 面板自动展开：等 plugins-changed → loader 热重建（异步）后面板
      // 可挂载，延迟后再请求激活（requestPanelActivation 复用 openPanel
      // 命令链——dock 悬浮展开 / sidebar 侧栏顶开，单选互斥）。
      window.setTimeout(() => requestPanelActivation(item.id), 900);
      break;
    case "rail-widget":
    case "composer-trailing":
      // 挂件位置高亮闪烁一次（rail 宿主消费 spotlight；composer 挂件同链）。
      window.setTimeout(() => requestInstallSpotlight(item.id), 900);
      break;
    case "event-hook":
      // 测试通知：确认通知通道畅通（复用 desktop-notify 动作的后端命令）。
      window.setTimeout(() => {
        void invokeCommand("desktop_notify_send", {
          title: "通知插件已启用",
          body: "这是一条测试通知——插件工作正常。",
          sessionId: null,
          sound: null,
        }).catch(() => undefined);
      }, 600);
      break;
    case "pipeline":
      // 流水线：确认卡文案已提示「立即试用」路径（插件中心·流水线 tab
      // 详情页「作为任务启动」）；/jishu-pipeline 命令亦可直达。
      break;
    default:
      break;
  }
}

export function HybridInstallConfirmation() {
  const [pending, setPending] = useState<PendingHybridPlugin[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await invokeCommand<PendingHybridPlugin[]>(
        "plugin_confirm_pending",
      );
      setPending(result ?? []);
    } catch {
      // 命令不存在（老后端）或后端错误——静默
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const confirm = useCallback(async (id: string, enabled: boolean) => {
    setBusyId(id);
    try {
      await invokeCommand("plugin_set_enabled", { pluginId: id, enabled });
      setPending(prev => prev.filter(p => p.id !== id));
      if (enabled) {
        // 5a：装好了在哪用？——按挂载形态自动展示（不用去能力中心找）。
        const item = pending.find(p => p.id === id);
        if (item) afterEnableShowcase(item);
      }
    } finally {
      setBusyId(null);
    }
  }, [pending]);

  if (pending.length === 0) return null;

  // 批次1：统一弹窗外壳（不可关闭——安全阀语义，preventClose 固定）；
  // 卡片本身为馆市场警示形态，中和 UniModal 卡底色（透明壳）。
  return (
    <UniModal
      open
      onClose={() => undefined}
      preventClose
      label="混合插件安装确认"
      className="w-auto max-w-none border-0 bg-transparent shadow-none"
    >
      <div className="flex max-w-[96vw] items-center justify-center gap-4 overflow-x-auto p-2">
      {pending.map((p) => (
        <div
          key={p.id}
          className="w-[min(480px,92vw)] shrink-0 rounded-xl border border-amber-500/40 bg-background p-5 shadow-2xl"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground">
                新混合插件安装确认
              </div>
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                <div><span className="text-foreground/80">{p.name}</span>（{p.id}）</div>
                <div>挂载：{p.mount} · 代码 {p.codeLines} 行</div>
                <div className="font-mono text-[10px] break-all text-muted-foreground/60">{p.dir}</div>
              </div>
              <div className="mt-3 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                混合插件包含自定义代码，会在会话界面运行。启用前建议检查代码内容。
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  disabled={busyId === p.id}
                  onClick={() => void confirm(p.id, true)}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" />
                  启用
                </button>
                <button
                  type="button"
                  disabled={busyId === p.id}
                  onClick={() => void confirm(p.id, false)}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                  暂不启用
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
      </div>
    </UniModal>
  );
}
