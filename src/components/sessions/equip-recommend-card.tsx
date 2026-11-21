// v0.9.8 需求5（合并版）：会话内装备推荐卡（L2 主战场）。
// agent 在回复中输出 <JISHU-EQUIP-RECOMMEND>{json}</JISHU-EQUIP-RECOMMEND>
// 块（组套协议，目录注入见 equip-catalog.md）——message-view 解析助手文本
// 里的该块并渲染成本卡：星级+贴任务理由+勾选微调+一键串行安装。
//
// 硬闸（hub 侧强制，不靠 agent 自觉）：
// - 每会话推荐卡渲染上限 = 配置 session_limit（超出渲染弱化提示行）；
// - 已推未装的 ref 不再进新卡（equip_recommended 过滤）。
// 画像落盘：块 profile 字段 → task_profiles 表（L1 消费的数据源）。

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, Loader2, Sparkles, X } from "lucide-react";
import { invokeCommand } from "@/hooks/use-invoke";
import { cn } from "@/lib/utils";
import {
  fetchEquipmentTags,
  fetchEquipConfig,
  fetchRecommended,
  fetchRecommendedCount,
  recordRecommended,
  saveProfile,
  type CatalogEntry,
} from "@/features/equipment/api";
import { buildCatalog } from "@/features/equipment/match";
import { kindNameOf, useEquipmentRunner } from "@/features/equipment/runner";

/** 会话 id 供给（MessageView 提供127；TextBlock 深层消费免逐层透传）。 */
export const EquipSessionContext = createContext<string | null>(null);

const OPEN = "<JISHU-EQUIP-RECOMMEND>";
const CLOSE = "</JISHU-EQUIP-RECOMMEND>";

export interface EquipRecommendItem {
  ref: string;
  reason: string;
}

export interface EquipRecommendPayload {
  items: EquipRecommendItem[];
  profile?: { scene?: string; keywords?: string[] };
}

export type EquipSegment =
  | { type: "text"; content: string }
  | { type: "recommend"; payload: EquipRecommendPayload };

/**
 * 文本 → 段分割（推荐块 + 普通文本）。容错：块内 JSON 非法/缺 items 时
 * 当普通文本（流式半写同理——无闭合标记不切分，闭合后下一渲染帧接管）。
 */
export function extractEquipSegments(text: string): EquipSegment[] {
  if (!text.includes(OPEN)) return [{ type: "text", content: text }];
  const segments: EquipSegment[] = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf(OPEN);
    if (start < 0) break;
    const end = rest.indexOf(CLOSE, start + OPEN.length);
    if (end < 0) break; // 半写：整段按文本处理（下次渲染重试）
    const before = rest.slice(0, start);
    if (before.trim()) segments.push({ type: "text", content: before.trimEnd() });
    const body = rest.slice(start + OPEN.length, end).trim();
    try {
      const payload = JSON.parse(body) as EquipRecommendPayload;
      if (Array.isArray(payload.items) && payload.items.length > 0) {
        segments.push({ type: "recommend", payload });
      }
    } catch {
      // JSON 非法：静默丢弃块（设计 §十二：失败静默不渲染，不报错打扰）。
    }
    rest = rest.slice(end + CLOSE.length).replace(/^\r?\n[\r\n]*/, "");
  }
  if (rest.trim()) segments.push({ type: "text", content: rest.trimEnd() });
  return segments;
}

/** ★ 星级渲染（设计内定：卡上可见，兼排序权重）。 */
function Stars({ n }: { n: number }) {
  return (
    <span className="shrink-0 font-mono text-[10px] text-amber-500" title={`${n}/5`}>
      {"★".repeat(Math.max(1, Math.min(5, n)))}
      <span className="text-muted-foreground/30">{"★".repeat(5 - Math.max(1, Math.min(5, n)))}</span>
    </span>
  );
}

interface CardRow {
  ref: string;
  reason: string;
  entry: CatalogEntry;
}

/**
 * 推荐卡本体。mount 时一次性装载数据（目录合并/已装态/硬闸判定），
 * 之后纯本地交互。安装走共享执行器（取消/重试/失败原因继承）。
 */
export const EquipRecommendCard = memo(function EquipRecommendCard({
  payload,
}: {
  payload: EquipRecommendPayload;
}) {
  const sessionId = useContext(EquipSessionContext);
  const { t } = useTranslation();
  const runner = useEquipmentRunner();
  const [phase, setPhase] = useState<"loading" | "hidden" | "limited" | "ready">("loading");
  const [rows, setRows] = useState<CardRow[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [expandedFail, setExpandedFail] = useState<string | null>(null);
  const profileRef = useRef(payload.profile);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // 配置闸：总开关/会话卡链路关 → 不渲染。
        const config = await fetchEquipConfig();
        if (cancelled || !config.enabled || !config.session_card) {
          setPhase("hidden");
          return;
        }
        if (!sessionId) {
          setPhase("hidden");
          return;
        }
        // 限次硬闸：已达每会话上限 → 弱化提示行（不再渲染完整卡）。
        const count = await fetchRecommendedCount(sessionId);
        if (cancelled) return;
        if (count >= config.session_limit) {
          setPhase("limited");
          return;
        }
        // 目录合并 + 已装态（派生态现场交叉算）。
        const [curated, tagRows, pluginList, skillInstalled, piSources] = await Promise.all([
          invokeCommand<Array<{ id: string; kind: string; title: string; description: string; required: boolean; tags?: string[]; stars?: number }>>(
            "market_list_curated",
            { scene: null },
          ).catch(() => []),
          fetchEquipmentTags(),
          invokeCommand<{ plugins: Array<{ id: string }> }>("plugin_list").catch(() => null),
          invokeCommand<Record<string, string>>("skillhub_installed").catch(() => ({})),
          invokeCommand<string[]>("pi_package_installed_sources").catch(() => []),
        ]);
        if (cancelled) return;
        const installedRefs = new Set<string>();
        for (const p of pluginList?.plugins ?? []) installedRefs.add(`curated:${p.id}`);
        for (const slug of Object.keys(skillInstalled ?? {})) installedRefs.add(`skillhub:${slug}`);
        for (const src of piSources ?? []) {
          const at = src.lastIndexOf("@");
          const base = at > 0 ? src.slice(0, at) : src;
          installedRefs.add(`pi:${base}`);
        }
        const catalog = buildCatalog(curated ?? [], tagRows);
        const byRef = new Map(catalog.map((c) => [c.ref, c]));
        // 防重复推：已推未装的 ref 过滤。
        const recommended = new Set(await fetchRecommended(sessionId));
        const nextRows: CardRow[] = [];
        for (const item of payload.items) {
          if (!item.ref || installedRefs.has(item.ref) || recommended.has(item.ref)) continue;
          const entry =
            byRef.get(item.ref) ??
            ({
              ref: item.ref,
              title: item.ref.replace(/^(curated:|skillhub:|pi:)/, ""),
              tags: [],
              stars: 3,
            } as CatalogEntry);
          nextRows.push({ ref: item.ref, reason: item.reason || "", entry });
        }
        if (nextRows.length === 0) {
          setPhase("hidden");
          return;
        }
        // 记已推（限次计数+防重数据面）+ 画像落盘（L1 数据源）。
        await recordRecommended(sessionId, nextRows.map((r) => r.ref));
        const profile = profileRef.current;
        if (profile?.scene || profile?.keywords?.length) {
          await saveProfile(sessionId, profile.scene ?? "custom", (profile.keywords ?? []).slice(0, 8));
        }
        if (cancelled) return;
        setRows(nextRows);
        setChecked(new Set(nextRows.map((r) => r.ref)));
        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("hidden");
      }
    })();
    return () => {
      cancelled = true;
    };
    // 故意空依赖：mount 一次性装载（payload 引用稳定——块解析产物）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 安装 meta：via=会话卡链路；tags=画像关键词与理由交集（安装时机固化原料）。 */
  const metaFor = (row: CardRow) => {
    const keywords = profileRef.current?.keywords ?? [];
    const tags = keywords.filter((k) => row.reason.includes(k)).slice(0, 4);
    return { via: "recommend-card", title: row.entry.title, tags: tags.length > 0 ? tags : keywords.slice(0, 3) };
  };

  const pendingRefs = useMemo(
    () => rows.filter((r) => checked.has(r.ref)).map((r) => r.ref),
    [rows, checked],
  );

  if (phase === "hidden" || phase === "loading") return null;

  if (phase === "limited") {
    return (
      <div className="my-1 rounded-[8px] border border-border/40 bg-[var(--tool-card-bg)] px-3 py-2 text-xs text-muted-foreground" data-equip-recommend="limited">
        {t("equip.recommendAlreadyDone", "本次会话已推荐过装备，可到插件市场查看更多")}
      </div>
    );
  }

  const done = !runner.running && runner.statuses.length > 0;
  const okCount = runner.statuses.filter((s) => s.state === "ok").length;
  const failed = runner.statuses.filter((s) => s.state === "fail");

  return (
    <div
      className="my-1.5 overflow-hidden rounded-[8px] border border-primary/35 bg-[var(--tool-card-bg)] shadow-sm"
      data-equip-recommend="card"
    >
      <div className="flex items-center gap-1.5 bg-primary/10 px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-semibold">{t("equip.recommendTitle", "为这个任务推荐装备")}</span>
      </div>
      <div className="space-y-1 px-3 py-2">
        {rows.map((row) => {
          const st = runner.statuses.find((s) => s.ref === row.ref);
          const isChecked = checked.has(row.ref);
          return (
            <label
              key={row.ref}
              className={cn("flex items-start gap-2 rounded-lg border px-2.5 py-2", st?.state === "ok" ? "border-border/40 opacity-70" : "border-border/60")}
            >
              <input
                type="checkbox"
                className="mt-0.5 h-3.5 w-3.5 accent-[var(--primary)]"
                checked={isChecked}
                disabled={runner.running || st?.state === "ok"}
                onChange={(e) =>
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(row.ref);
                    else next.delete(row.ref);
                    return next;
                  })
                }
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-foreground">{row.entry.title}</span>
                  <Stars n={row.entry.stars} />
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {kindNameOf(row.ref, row.entry.kind, t)}
                  </span>
                </span>
                {row.reason && (
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{row.reason}</span>
                )}
                {st?.state === "fail" && (
                  <span className="mt-0.5 block">
                    <button
                      type="button"
                      className="text-[10px] text-destructive underline-offset-2 hover:underline"
                      onClick={(e) => {
                        e.preventDefault();
                        setExpandedFail(expandedFail === row.ref ? null : row.ref);
                      }}
                    >
                      {t("equip.installFailedWhy", "安装失败，查看原因")}
                    </button>
                    {expandedFail === row.ref && (
                      <span className="mt-0.5 block max-h-24 overflow-y-auto break-all font-mono text-[10px] text-destructive/80">
                        {(st.error ?? "").slice(0, 200)}
                      </span>
                    )}
                  </span>
                )}
              </span>
              {st?.state === "running" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
              {st?.state === "ok" && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--icon-success)]" />}
              {st?.state === "fail" && <X className="h-3.5 w-3.5 shrink-0 text-destructive" />}
            </label>
          );
        })}
        {/* ④：含技能项时的安全说明行（与单品安装披露口径对齐）。 */}
        {runner.hasSkill && !done && (
          <p className="px-0.5 text-[10px] text-muted-foreground/80">
            {t("equip.skillSafetyNote", "技能项将安装到本地技能目录，已通过完整性校验")}
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/40 px-3 py-2">
        {done ? (
          <span className="text-xs text-muted-foreground">
            {t("equip.installDone", { defaultValue: "安装完成：成功 {{ok}} 项、失败 {{fail}} 项", ok: okCount, fail: failed.length })}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">
            {t("equip.recommendHint", "取消勾选可跳过不需要的装备")}
          </span>
        )}
        <span className="flex items-center gap-1.5">
          {runner.running ? (
            <button
              type="button"
              className="rounded-md border border-border/60 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => runner.cancel()}
            >
              {t("equip.cancelRemaining", "取消剩余项")}
            </button>
          ) : (
            failed.length > 0 && (
              <button
                type="button"
                className="rounded-md border border-border/60 px-2 py-1 text-[10px] hover:bg-accent/50"
                onClick={() => runner.retryFailed()}
              >
                {t("equip.retryFailed", "重试失败项")}
              </button>
            )
          )}
          {!done && (
            <button
              type="button"
              disabled={pendingRefs.length === 0}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
              onClick={() => {
                const items = rows.filter((r) => pendingRefs.includes(r.ref)).map((r) => ({ ref: r.ref, meta: metaFor(r) }));
                if (items.length > 0) runner.run(items);
              }}
            >
              <Download className="h-3 w-3" />
              {t("equip.installSelected", { defaultValue: "安装选中项 ({{n}})", n: pendingRefs.length })}
            </button>
          )}
        </span>
      </div>
    </div>
  );
});
