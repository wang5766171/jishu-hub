/**
 * v0.9.7 需求3 C2：插件市场面板（三源一套交互）。
 *
 * - 精选：curated.json（19 件 required「系统内置」+ 可选件可装可卸）+ 场景筛选。
 * - 扩展生态：pi npm 扩展包目录（钉版 5 包；启停与安装走同一执行面）。
 * - 技能市场：腾讯 SkillHub（场景分组/搜索/分页；安装前安全确认——
 *   来源/版本/发布者认证/是否需要密钥；装后各智能体立即可用）。
 * - 已装判定：精选/扩展 = plugin_list 交集；技能 = skillhub_installed 台账。
 * - 文案不暴露内部引擎代号（§7）：三源页签名为 精选/扩展生态/技能市场。
 *
 * 评审 P2-12 处置说明（不拆分，第三轮评审更新口径）：九轮「已安装统一
 * 页」抽出后，已装/批量更新状态机（extUpdates/skillUpdates/
 * checkingUpdates/updateBusy/batchUpdates/extInstalled/extVersions 等）
 * 已全部迁往 plugins-page.tsx——本组件仅剩市场三源装载（onlineInstalled/
 * skillInstalled/piindex/busyIds）与 load/onChanged 回调。文件规模与拆分
 * 处置仍随 chat-page 拆分方向后续评估。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand } from "@/hooks/use-invoke";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PLUGIN_SCENES } from "@/lib/plugin-scenes";
import { ArrowDownToLine, Bot, Check, Download, ExternalLink, Info, Loader2, Package, RefreshCw, Search, X, ShieldCheck, Sparkles, Star, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InstallGuideCard, type InstallGuideInfo } from "@/components/market/install-guide-card";
import { buildGuiAdaptDraft } from "@/components/market/gui-adapt-draft";
// v0.9.8 需求5（合并版）：装备推荐——共享执行器（五修）+ L1/L0 匹配 + 目录。
import { fetchEquipConfig, fetchEquipmentTags, fetchLatestProfile, fetchWorkspaceScene, type CatalogEntry } from "@/features/equipment/api";
import { buildCatalog, matchByProfile, matchByWorkspaceScene } from "@/features/equipment/match";
import { kindNameOf, useEquipmentRunner } from "@/features/equipment/runner";
import { setMarketOpen } from "@/lib/market-update-signal";

interface MarketEntry {
  id: string;
  kind: string;
  title: string;
  description: string;
  category: string;
  scenes: string[];
  required: boolean;
  /** v0.9.8 需求4：装后引导卡示例 prompt（curated 可选，serde skip None）。 */
  usage_hint?: string;
}

/** v0.9.8 需求5：场景套装（curated.json bundles 段，Rust market_list_bundles）。 */
interface MarketBundle {
  id: string;
  scene: string;
  title: string;
  description: string;
  items: Array<{ ref: string; required: boolean }>;
}

interface PiPackageEntry {
  plugin_id: string;
  name: string;
  source: string;
  version: string;
  description: string;
  installed: boolean;
}

interface SkillhubEntry {
  slug: string;
  name: string;
  description: string;
  category: string;
  downloads: unknown;
  score: unknown;
  version: string;
  requires_api_key: boolean;
  publisher_verified: boolean;
  publisher_name: string;
}

interface SkillhubListResult {
  entries: SkillhubEntry[];
  total: number;
  page: number;
  page_size: number;
}

type MarketSource = "curated" | "extensions" | "skills";

/** 需求7 修1a：扩展生态在线库条目（npm pi-package 检索）。 */
interface PiOnlinePackage {
  name: string;
  version: string;
  description: string;
  publisher: string;
  date: string;
}

/** 需求3 补充（2026-11-13）：Pi Index 在线目录条目（piindex.dev——
 * awesome-pi 清单）与更新状态形态。评审 #13 修复：字段名与后端 serde
 * snake_case 冻结形态对齐（跨端统一，camelCase 曾致整卡 undefined）。 */
interface PiindexEntry {
  name: string;
  description: string;
  npm_package: string | null;
  github_url: string | null;
  /** 完整安装命令原文（npm:/git: 源卡都有；安装按钮取命令尾段作源）。 */
  install_command: string;
  category: string;
  kind_label: string;
  detail_url: string | null;
  stars: number | null;
  weekly_downloads: number | null;
  /** 周下载量涨跌（「▼30%」/「▲1%」；部分卡缺）。 */
  download_trend: string | null;
  search_text: string;
}

/** 需求15 方案 A：在线安装结果（serde tag=status）——冲突时弹确认卡。 */
interface InstallOnlineOutcome {
  status: "installed" | "conflict";
  conflicts?: Array<{
    tool: string;
    opponent_source: string;
    opponent_display: string;
    opponent_builtin: boolean;
  }>;
}

/** 需求15 方案 A：停用台账条目（pi_extension_overrides_list）。 */
interface PiOverrideEntryView {
  source: string;
  builtin: boolean;
  display: string;
  replaced_by: string;
}

/** 需求4 D4-8b：扩展统一登记簿条目（extension_registry_list，snake_case）。 */
interface ExtGuiEntryView {
  source: string;
  pkg_key: string;
  display: string;
  builtin: boolean;
  state: string;
  replaced_by: string | null;
  gui_verdict: string;
  verdict_note: string | null;
  adapters: Array<{ plugin_id: string; enabled: boolean; cascade_disabled: boolean }>;
}

/** 注册串 → 无版本关系键（npm:pkg@1.0 → npm:pkg；非 npm 源原样）。 */
function pkgKeyOf(source: string): string {
  if (!source.startsWith("npm:")) return source;
  const rest = source.slice(4);
  const m = rest.match(/^(@[^/]+\/[^@]+|[^@]+)@.*$/);
  return "npm:" + (m ? m[1] : rest);
}

/** 已装源串与 piindex 条目匹配（npm 源按包名前缀；git 源归一 https
 * 前缀后比对安装命令尾段）——已装卡说明/查看来源的元数据来源。 */
function installedSourceMatchesPiindex(src: string, entry: PiindexEntry): boolean {
  if (entry.npm_package) {
    const prefix = "npm:" + entry.npm_package;
    if (src === prefix || src.startsWith(prefix + "@")) return true;
  }
  if (entry.install_command.startsWith("pi install git:")) {
    const cmdSource = entry.install_command.replace(/^pi install /, "");
    const norm = (s: string) => s.replace(/^git:https?:\/\//, "git:");
    return norm(src) === norm(cmdSource);
  }
  return false;
}

const PAGE_SIZE_OPTIONS = [20, 50, 100];

/** 评审 P1-13 修复②：load 世代号（模块级递增）——await 返回后 runId 不匹配
 * 即丢弃 setState，防 keyword/onlineKw 快慢响应交错覆盖新结果。 */
let marketLoadRunId = 0;

/** 计数缩写（对齐 piindex 呈现）：≥1万保留 1 位小数以万计，不足显示整数。 */
function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "-";
  return n >= 10000 ? `${Math.round(n / 1000) / 10}万` : String(Math.floor(n));
}

/** 周下载涨跌着色与间距：彩色主题红绿区分涨跌（colorful: variant），黑白
 * （亮/暗）主题统一灰不抢焦点；ml-1 与「/周」保持间距。 */
function trendClass(trend: string): string {
  const color = trend.includes("▲")
    ? "text-muted-foreground colorful:text-emerald-600"
    : "text-muted-foreground colorful:text-red-500";
  return `ml-1 ${color}`;
}

/** 分页条（在线扩展库客户端分页 / 技能市场服务端分页共用——
 * 页码 + 总数 + 每页条数选择，最大 100）。 */
/** 统一搜索框（十四轮布局+十五轮一键清除）：放大镜左侧、清除按钮右侧
 * （有值时显示，点击清空并触发 onChange("")）。 */
export function MarketSearchBox({
  value,
  onChange,
  placeholder,
  width = "w-48",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  width?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`h-7 ${width} rounded-md border border-border/60 bg-background pl-7 pr-6 text-xs outline-none placeholder:text-muted-foreground/50 focus:border-primary/50`}
      />
      {value.trim() && (
        <button
          type="button"
          aria-label={t("market.clearSearch", "清除搜索")}
          title={t("market.clearSearch", "清除搜索")}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/60 hover:bg-accent/60 hover:text-foreground"
          onClick={() => onChange("")}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function MarketPager({
  page,
  pageCount,
  total,
  pageSize,
  onPage,
  onPageSize,
  disabled,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground">
      <Button variant="outline" size="sm" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>
        {t("market.prevPage", "上一页")}
      </Button>
      <span>
        {t("market.pageInfo", "第 {{page}} / {{pages}} 页 · 共 {{total}} 项", { page, pages: pageCount, total })}
      </span>
      <Button variant="outline" size="sm" disabled={disabled || page >= pageCount} onClick={() => onPage(page + 1)}>
        {t("market.nextPage", "下一页")}
      </Button>
      <label className="ml-1 inline-flex items-center gap-1">
        {t("market.pageSize", "每页")}
        <select
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-xs outline-none focus:border-primary/50"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function PluginMarketPanel({
  onChanged,
  onLaunchDescribe,
  onNavigateConfig,
}: {
  onChanged?: () => void;
  /** v0.9.8 需求4：GUI 适配入口——跳会话预填创作指令（App 层
   * pluginCreateLaunch 创建联动链复用，v0.9.7 需求3 资产）。 */
  onLaunchDescribe?: (text: string) => void;
  /** v0.9.8 需求4：装后引导卡「需要配置」一键到配置位（App 层跳管理页）。 */
  onNavigateConfig?: () => void;
}) {
  const { t } = useTranslation();
  const { confirm: confirmDialog, dialogNode: confirmDialogNode } = useConfirmDialog();
  const [source, setSource] = useState<MarketSource>("curated");
  const [scene, setScene] = useState<string>("all");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  // 需求3 六轮：完整分页（在线扩展客户端切片 / 技能市场服务端参数），
  // 每页条数可设（20/50/100）。
  const [extPage, setExtPage] = useState(1);
  const [extPageSize, setExtPageSize] = useState(20);
  const [skillPageSize, setSkillPageSize] = useState(20);

  const [curated, setCurated] = useState<MarketEntry[]>([]);
  // v0.9.8 需求5：套装 curated: 引用解析用全量清单 ref（scene 过滤态下也需全量）。
  const bundleCuratedRef = useRef<MarketEntry[]>([]);
  // v0.9.8 需求5：场景套装（精选源场景筛选区上方横滑卡）。
  const [bundles, setBundles] = useState<MarketBundle[]>([]);
  const [bundleOpen, setBundleOpen] = useState<(MarketBundle & { dynamicNote?: string }) | null>(null);
  const [bundleChecked, setBundleChecked] = useState<Set<string>>(new Set());
  // 需求5（合并版）：「为你推荐」动态区（L1 画像命中 ≥2 件时呈现；否则回落
  // 入门套装横滑）。执行器抽离共享 hook（五修：取消令牌/重试保历史/失败
  // 原因/安全行/类型名）。
  const bundleRunner = useEquipmentRunner();
  // v0.9.8 评审修复轮 R1-6：byWorkspace/basis 记录推荐来源（项目特征命中）
  // 与原始特征文字——弹层描述据此选整句，不把「项目特征：…」套进别的句式。
  const [recommendZone, setRecommendZone] = useState<{
    note: string;
    byWorkspace: boolean;
    basis: string;
    items: CatalogEntry[];
  } | null>(null);
  useEffect(() => {
    if (source !== "curated") return;
    let cancelled = false;
    void (async () => {
      const config = await fetchEquipConfig();
      if (cancelled || !config.enabled || !config.market_zone) {
        setRecommendZone(null);
        return;
      }
      const [curated, tagRows, pluginList, skillInstalled, piSources, profile, wsScene] = await Promise.all([
        invokeCommand<Array<{ id: string; kind: string; title: string; description: string; required: boolean; tags?: string[]; stars?: number }>>(
          "market_list_curated",
          { scene: null },
        ).catch(() => []),
        fetchEquipmentTags(),
        invokeCommand<{ plugins: Array<{ id: string }> }>("plugin_list").catch(() => null),
        invokeCommand<Record<string, string>>("skillhub_installed").catch(() => ({})),
        invokeCommand<string[]>("pi_package_installed_sources").catch(() => []),
        fetchLatestProfile(),
        // 工作区场景（用户裁决「按项目定位」）：市场页无项目上下文——
        // 取最近活跃项目（编码名，Rust 端解码）做特征分析；默认空间无定论回落画像。
        invokeCommand<string | null>("load_last_project").then((enc) =>
          enc ? fetchWorkspaceScene(enc) : null,
        ).catch(() => null),
      ]);
      if (cancelled) return;
      const installedRefs = new Set<string>();
      for (const p of pluginList?.plugins ?? []) installedRefs.add(`curated:${p.id}`);
      for (const slug of Object.keys(skillInstalled ?? {})) installedRefs.add(`skillhub:${slug}`);
      for (const src of piSources ?? []) {
        const at = src.lastIndexOf("@");
        installedRefs.add(`pi:${at > 0 ? src.slice(0, at) : src}`);
      }
      const catalog = buildCatalog(curated ?? [], tagRows);
      const mInput = { catalog, installedRefs, officialOnly: !config.third_party };
      // 优先级：工作区场景（项目特征）→ 最近任务画像。
      const wsPicks = wsScene ? matchByWorkspaceScene(wsScene.scene, mInput, 6) : [];
      const hits = wsPicks.length >= 2
        ? wsPicks
        : profile
          ? matchByProfile(profile, mInput, 6).map((h) => h.entry)
          : [];
      if (!cancelled) {
        setRecommendZone(
          hits.length >= 2
            ? {
                note: wsPicks.length >= 2
                  ? t("market.recommendByProject", { defaultValue: "项目特征：{{basis}}", basis: (wsScene?.basis ?? []).slice(0, 2).join(" / ") })
                  : profile?.keywords.slice(0, 3).join(" / ") ?? "",
                // v0.9.8 评审修复轮 R1-6：推荐来源显式区分——项目特征与最近
                // 任务各用各的整句，不再把「项目特征：…」套进「根据最近任务」。
                byWorkspace: wsPicks.length >= 2,
                basis: (wsScene?.basis ?? []).slice(0, 2).join(" / "),
                items: hits,
              }
            : null,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);
  // v0.9.8 需求8 A3：扩展目录慢载兜底——piindex 无缓存且拉取中超过 8s 给
  // 「网络不佳」提示+重试（预拉取就位后仅首装首开会走到这里）。
  const [extSlow, setExtSlow] = useState(false);
  const [extensions, setExtensions] = useState<PiPackageEntry[]>([]);
  const [onlineKw, setOnlineKw] = useState("");
  // 十四轮 UI 统一：精选页签统一搜索框（本地按名称/说明过滤）。
  const [curatedKw, setCuratedKw] = useState("");
  const [online, setOnline] = useState<PiOnlinePackage[] | null>(null);
  const [onlineInstalled, setOnlineInstalled] = useState<string[]>([]);
  // 需求15 方案 A：冲突停用台账（卡上呈现「已停用（被 XX 替代）」——
  // 内置不可删除只显示替代提示；用户停用件可删除）。
  const [piOverrides, setPiOverrides] = useState<PiOverrideEntryView[]>([]);
  // 需求4 D4-8b：扩展统一登记簿（已装卡「界面」行+卸载依赖提示用）。
  const [extGui, setExtGui] = useState<Map<string, ExtGuiEntryView>>(new Map());
  const refreshExtGui = useCallback(() => {
    void invokeCommand<ExtGuiEntryView[]>("extension_registry_list")
      .then((entries) => setExtGui(new Map((entries ?? []).map((e) => [e.pkg_key, e]))))
      .catch(() => setExtGui(new Map()));
  }, []);
  useEffect(() => { refreshExtGui(); }, [refreshExtGui]);
  /** 安装后即时判定（fresh 读登记簿）：已适配→providedBy；判定无需→收起入口。 */
  const guiStateFor = useCallback(async (source: string): Promise<{ providedBy?: string; noneeded?: boolean }> => {
    try {
      const entries = await invokeCommand<ExtGuiEntryView[]>("extension_registry_list");
      const entry = (entries ?? []).find((e) => e.pkg_key === pkgKeyOf(source));
      if (!entry) return {};
      if (entry.adapters.length > 0) return { providedBy: entry.adapters[0].plugin_id };
      if (entry.gui_verdict === "noneeded") return { noneeded: true };
      return {};
    } catch {
      return {};
    }
  }, []);
  // 需求3 补充：piindex 检索结果（在线库主源；npm 检索为兜底）；更新检查。
  const [piindex, setPiindex] = useState<PiindexEntry[] | null>(null);
  // 需求3 四轮：分类过滤 / 重新加载。
  const [extCategory, setExtCategory] = useState<string>("all");
  const [reloading, setReloading] = useState(false);
  const [skills, setSkills] = useState<SkillhubListResult | null>(null);
  const [skillInstalled, setSkillInstalled] = useState<Record<string, string>>({});
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // v0.9.8 需求9-③：单值互斥 → per-item busy 集合。此前一个技能安装中时
  // 另一项点击被静默丢弃（if (busyId) return）——技能安装与市场安装无资源
  // 冲突，允许并行；同一项重复点击仍幂等拒绝（busyIds.has 同项守卫）。
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  // ── v0.9.8 需求4：安装完成引导卡（三源统一形态）─────────────────────────
  // 「装完即散」改为引导卡：装了什么/是否需要配置/首次怎么用/GUI 适配入口
  //（pi 扩展类）。非阻断 toast，× 手动关。
  const [guideCard, setGuideCard] = useState<InstallGuideInfo | null>(null);
  const mapGuideKind = useCallback((kind: string): InstallGuideInfo["kind"] => {
    if (kind === "pi-package") return "extension";
    if (kind === "composed" || kind === "composed-theme") return "composed";
    return "plugin";
  }, []);
  /** 技能类示例：模板句（需求4 D4-4——不再复用描述首句，与说明文字同文
   * 无信息量；skillhub 元数据暂无示例字段，给可操作的用法句式）。 */
  const firstSentence = useCallback((text: string) => {
    const name = text.split(/[。．!？！?\n]/)[0]?.trim() || text.slice(0, 24) || "该技能";
    return t("market.skillFirstUse", {
      defaultValue: "在会话里说：使用「{{name}}」完成对应任务",
      name,
    });
  }, [t]);
  /** GUI 适配预填文案（需求4 F5）：委托共享实现（与已装页持久入口同源，
   * 官方信息源四通道+第 0 步判定+双语）。 */
  const buildGuiAdaptText = useCallback(
    (info: InstallGuideInfo) => buildGuiAdaptDraft(t, info),
    [t],
  );

  // 评审 P1-13 修复①：搜索关键词 300ms 防抖（局部 state + 定时器，卸载清理
  // 由 effect 返回）——不再每击键立即触发 load 发 IPC。
  const [debouncedKeyword, setDebouncedKeyword] = useState(keyword);
  const [debouncedOnlineKw, setDebouncedOnlineKw] = useState(onlineKw);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), 300);
    return () => clearTimeout(timer);
  }, [keyword]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedOnlineKw(onlineKw), 300);
    return () => clearTimeout(timer);
  }, [onlineKw]);

  const refreshInstalled = useCallback(async () => {
    try {
      const result = await invokeCommand<{ plugins: Array<{ id: string; enabled: boolean }> }>("plugin_list");
      setInstalledIds(new Set((result.plugins ?? []).map((p) => p.id)));
    } catch {
      /* plugin_list 失败保持当前值 */
    }
  }, []);

  // 十五轮：分类基准快照——目录全量（首次非搜索加载冻结）。分类 chips
  // 从全量派生，不随搜索结果汇聚变化（搜索只过滤列表，页面不跳动）。
  const fullCatalogRef = useRef<PiindexEntry[] | null>(null);
  const extCategories = useMemo(() => {
    const base = fullCatalogRef.current ?? piindex ?? [];
    const set = new Set<string>();
    for (const e of base) {
      for (const c of e.category.split("/")) {
        const t = c.trim();
        if (t) set.add(t);
      }
    }
    return ["all", ...[...set].sort((a, b) => a.localeCompare(b, "zh"))];
  }, [piindex]);
  const filteredPiindex = useMemo(() => {
    if (!piindex) return null;
    return extCategory === "all" ? piindex : piindex.filter((e) => e.category.split("/").some((c) => c.trim() === extCategory));
  }, [piindex, extCategory]);
  // 客户端分页（在线库全量 ~170 条）：过滤结果切片，页码/过滤变化自动对齐。
  const extTotal = filteredPiindex?.length ?? 0;
  const extPageCount = Math.max(1, Math.ceil(extTotal / extPageSize));
  useEffect(() => {
    if (extPage > extPageCount) setExtPage(1);
  }, [extPage, extPageCount]);
  const pagedPiindex = useMemo(
    () => (filteredPiindex ?? []).slice((extPage - 1) * extPageSize, extPage * extPageSize),
    [filteredPiindex, extPage, extPageSize],
  );

  const load = useCallback(async () => {
    // 评审 P1-13 修复②：仅最新一次 load 允许落地 setState。
    const runId = ++marketLoadRunId;
    setLoading(true);
    setError(null);
    try {
      // curated 为内嵌数据（廉价）——三源共用（扩展生态的 required 判定也读它）。
      const sceneArg = scene === "all" ? null : scene;
      const curatedEntries = await invokeCommand<MarketEntry[]>("market_list_curated", {
        scene: source === "curated" ? sceneArg : null,
      });
      if (runId !== marketLoadRunId) return;
      setCurated(curatedEntries ?? []);
      // v0.9.8 需求5：套装清单（内嵌廉价，每次 load 同步刷新；curated: 引用
      // 的展示名解析用全量 entries——scene 过滤态下也要能解析，故独立拉全量）。
      const [bundleList, allCurated] = await Promise.all([
        invokeCommand<MarketBundle[]>("market_list_bundles").catch(() => [] as MarketBundle[]),
        invokeCommand<MarketEntry[]>("market_list_curated", { scene: null }),
      ]);
      if (runId !== marketLoadRunId) return;
      setBundles(bundleList ?? []);
      bundleCuratedRef.current = allCurated ?? [];
      if (source !== "skills") {
        await refreshInstalled();
        if (runId !== marketLoadRunId) return;
      }
      if (source === "extensions") {
        const entries = await invokeCommand<PiPackageEntry[]>("pi_package_catalog");
        if (runId !== marketLoadRunId) return;
        setExtensions(entries ?? []);
        // 需求3 补充：在线库主源换 Pi Index（piindex.dev/awesome-pi 清单），
        // npm pi-package 检索为兜底（piindex 不可达时回落）。
        const sources = await invokeCommand<string[]>("pi_package_installed_sources").catch(() => [] as string[]);
        if (runId !== marketLoadRunId) return;
        setOnlineInstalled(sources ?? []);
        // 需求15 方案 A：冲突停用台账随已装源同槽装载（安装/卸载后 load()
        // 刷新即同步）。
        const overrides = await invokeCommand<PiOverrideEntryView[]>("pi_extension_overrides_list").catch(() => []);
        if (runId !== marketLoadRunId) return;
        setPiOverrides(overrides ?? []);
        try {
          const results = await invokeCommand<PiindexEntry[]>("piindex_search", {
            keyword: debouncedOnlineKw.trim() || null,
          });
          if (runId !== marketLoadRunId) return;
          setPiindex(results ?? []);
          // 全量目录快照冻结（分类基准，不随搜索变化）。
          if (!debouncedOnlineKw.trim()) fullCatalogRef.current = results ?? [];
          setOnline(null);
        } catch {
          if (runId !== marketLoadRunId) return;
          setPiindex(null);
          try {
            const results = await invokeCommand<PiOnlinePackage[]>("pi_package_search", {
              keyword: debouncedOnlineKw.trim() || null,
            });
            if (runId !== marketLoadRunId) return;
            setOnline(results ?? []);
          } catch (e) {
            if (runId !== marketLoadRunId) return;
            setError(String(e));
          }
        }
      } else if (source === "skills") {
        const kw = debouncedKeyword.trim() || null;
        const result = await invokeCommand<SkillhubListResult>("skillhub_list", {
          scene: sceneArg,
          keyword: kw,
          page,
          pageSize: skillPageSize,
        });
        if (runId !== marketLoadRunId) return;
        setSkills(result);
        const installed = await invokeCommand<Record<string, string>>("skillhub_installed");
        if (runId !== marketLoadRunId) return;
        setSkillInstalled(installed ?? {});
      }
    } catch (e) {
      if (runId !== marketLoadRunId) return;
      setError(String(e));
    } finally {
      if (runId === marketLoadRunId) setLoading(false);
    }
  }, [source, scene, debouncedKeyword, page, debouncedOnlineKw, skillPageSize, refreshInstalled]);

  useEffect(() => {
    void load();
  }, [load]);

  // v0.9.8 需求8 A2 → D8-1 改造：预拉取通知（piindex-updated）不再自动
  // reload 打断浏览——页顶横幅提示「市场目录已更新 · 查看」，点查看才刷新；
  // 红点信号（人在别页）由 market-update-signal 承接，此处置位市场页打开
  // 标记。
  const [catalogUpdated, setCatalogUpdated] = useState(false);
  useEffect(() => {
    setMarketOpen(true);
    return () => setMarketOpen(false);
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen("piindex-updated", () => {
      setCatalogUpdated(true);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // v0.9.8 需求8 A3：扩展目录慢载判定（8s 无数据 → 兜底提示态）。
  // D8-2：npm 兜底已有数据（online）时不算慢载——转圈即撤。
  useEffect(() => {
    if (!(source === "extensions" && loading && piindex === null && online === null)) {
      setExtSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setExtSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [source, loading, piindex, online]);

  // 需求3 补充：技能详情（skillhub_detail 拉取，弹窗展示）。
  const [skillDetailOpen, setSkillDetailOpen] = useState(false);
  const [skillDetail, setSkillDetail] = useState<SkillhubEntry | null>(null);
  const [extDetailEntry, setExtDetailEntry] = useState<PiindexEntry | null>(null);
  const [skillDetailLoading, setSkillDetailLoading] = useState(false);
  const openSkillDetail = useCallback(async (slug: string) => {
    setSkillDetailOpen(true);
    setSkillDetailLoading(true);
    try {
      setSkillDetail(await invokeCommand<SkillhubEntry>("skillhub_detail", { slug }));
    } catch (e) {
      setActionError(String(e));
      setSkillDetailOpen(false);
    } finally {
      setSkillDetailLoading(false);
    }
  }, []);

  const act = useCallback(
    async (id: string, action: "install" | "uninstall", confirm?: () => Promise<boolean>) => {
      if (busyIds.has(id)) return;
      if (confirm) {
        const ok = await confirm();
        if (!ok) return;
      }
      setActionError(null);
      setBusyIds((prev) => new Set(prev).add(id));
      try {
        const command = action === "install" ? "market_install" : "market_uninstall";
        await invokeCommand<string>(command, { pluginId: id });
        if (action === "install") {
          // v0.9.8 需求4：装后引导卡（精选源）——curated 条目即卡数据源。
          const entry = curated.find((c) => c.id === id);
          if (entry) {
            setGuideCard({
              title: entry.title,
              kind: mapGuideKind(entry.kind),
              description: entry.description,
              usageHint: entry.usage_hint,
            });
          }
        }
        onChanged?.();
        await load();
      } catch (e) {
        setActionError(String(e));
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [busyIds, curated, load, mapGuideKind, onChanged],
  );

  const installSkill = useCallback(
    async (entry: SkillhubEntry) => {
      const ok = await confirmDialog({
        title: t("market.skillConfirmTitle", { defaultValue: "安装技能：{{name}}", name: entry.name }),
        description: [
          `${t("market.skillSource", "来源")}：SkillHub（${entry.slug}）`,
          `${t("market.skillVersion", "版本")}：${entry.version || "latest"}`,
          `${t("market.skillPublisher", "发布者")}：${entry.publisher_name || "-"}${entry.publisher_verified ? " ✅" : ""}`,
          `${t("market.skillApiKey", "需要 API Key")}：${entry.requires_api_key ? t("common.yes", "是") : t("common.no", "否")}`,
          t("market.skillRiskNote", "技能为第三方提示词文件包，安装后 agent 可读取执行；已校验包含 SKILL.md 且拒绝路径穿越。"),
        ].join("\n"),
        confirmText: t("market.install", "安装"),
      });
      if (!ok) return;
      if (busyIds.has(entry.slug)) return;
      setActionError(null);
      setBusyIds((prev) => new Set(prev).add(entry.slug));
      try {
        await invokeCommand<string>("skillhub_install", { slug: entry.slug });
        // v0.9.8 需求4：装后引导卡（技能源）——描述首句为建议 prompt；
        // requires_api_key 给一键到配置位。
        setGuideCard({
          title: entry.name,
          kind: "skill",
          description: entry.description,
          requiresApiKey: entry.requires_api_key,
          usageHint: entry.description ? firstSentence(entry.description) : undefined,
        });
        await load();
      } catch (e) {
        setActionError(String(e));
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(entry.slug);
          return next;
        });
      }
    },
    [busyIds, confirmDialog, firstSentence, load, t],
  );

  const uninstallSkill = useCallback(
    async (slug: string) => {
      if (busyIds.has(slug)) return;
      setActionError(null);
      setBusyIds((prev) => new Set(prev).add(slug));
      try {
        await invokeCommand<string>("skillhub_uninstall", { slug });
        await load();
      } catch (e) {
        setActionError(String(e));
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(slug);
          return next;
        });
      }
    },
    [busyIds, load],
  );

  // ── v0.9.8 需求5（合并版）：套装/推荐条目解析 ─────────────────────────
  // 执行器抽离至 useEquipmentRunner（五修：取消令牌/重试保历史/失败原因/
  // 安全行/类型名）；此处仅条目解析。
  /** curated:/skillhub:/pi: 引用 → 展示条目（curated: 未命中 = 清单漂移
   * 不可用；skillhub/pi 下架在安装期以失败态呈现——单项失败不打断整批）。
   * 五修⑤：类型名精确（kindNameOf 单源）+ skillhub 友好名（标签库 title）。 */
  const equipTagsRef = useRef<Array<{ ref: string; title: string }>>([]);
  useEffect(() => {
    void fetchEquipmentTags().then((rows) => {
      equipTagsRef.current = rows.map((r) => ({ ref: r.ref, title: r.title }));
    });
  }, []);
  const resolveBundleItem = useCallback(
    (ref: string): { title: string; kindName: string; installed: boolean; unavailable: boolean; stars: number } => {
      if (ref.startsWith("curated:")) {
        const id = ref.slice("curated:".length);
        const e = bundleCuratedRef.current.find((c) => c.id === id);
        if (!e) return { title: ref, kindName: "-", installed: false, unavailable: true, stars: 3 };
        return {
          title: e.title,
          kindName: kindNameOf(ref, (e as { kind?: string }).kind, t),
          installed: installedIds.has(id),
          unavailable: false,
          stars: (e as { stars?: number }).stars ?? 3,
        };
      }
      if (ref.startsWith("skillhub:")) {
        const slug = ref.slice("skillhub:".length);
        // 五修⑤：skillhub 条目友好名——标签库 title（无则回退 slug）。
        const friendly = equipTagsRef.current.find((r) => r.ref === ref)?.title;
        return {
          title: friendly || slug,
          kindName: kindNameOf(ref, undefined, t),
          installed: !!skillInstalled[slug],
          unavailable: false,
          stars: 3,
        };
      }
      if (ref.startsWith("pi:")) {
        const source = ref.slice("pi:".length);
        return {
          title: equipTagsRef.current.find((r) => r.ref === ref)?.title || source,
          kindName: kindNameOf(ref, undefined, t),
          installed: false,
          unavailable: false,
          stars: 3,
        };
      }
      return { title: ref, kindName: "-", installed: false, unavailable: true, stars: 3 };
    },
    [installedIds, skillInstalled, t],
  );

  /** 弹层启动安装（执行器完成后刷新清单——与旧执行器行为一致）。 */
  const startBundleRun = useCallback(() => {
    if (!bundleOpen) return;
    bundleRunner.setOnDone(() => {
      onChanged?.();
      void load();
      bundleRunner.setOnDone(null);
    });
    const refs = bundleOpen.items
      .filter((i) => i.required || bundleChecked.has(i.ref))
      .filter((i) => !resolveBundleItem(i.ref).installed && !resolveBundleItem(i.ref).unavailable)
      .map((i) => i.ref);
    if (refs.length > 0) {
      // 市场侧安装统一记 via=market-zone（入门套装/动态推荐同面）。
      bundleRunner.run(refs.map((ref) => ({ ref, meta: { via: "market-zone" } })));
    }
  }, [bundleChecked, bundleOpen, bundleRunner, load, onChanged, resolveBundleItem]);

  const sceneTabs = useMemo(
    () => [{ id: "all", label: t("market.sceneAll", "全部") }, ...PLUGIN_SCENES.map((s) => ({ id: s.id, label: t(s.nameKey) }))],
    [t],
  );

  const sources: Array<{ key: MarketSource; icon: typeof Sparkles; label: string }> = [
    { key: "curated", icon: Sparkles, label: t("market.sourceCurated", "精选") },
    { key: "extensions", icon: Package, label: t("market.sourceExtensions", "扩展生态") },
    { key: "skills", icon: Bot, label: t("market.sourceSkills", "技能市场") },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* 三源页签 + 场景筛选（精选/技能市场有效） */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {sources.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => {
                setSource(s.key);
                setPage(1);
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                source === s.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <s.icon className="h-3 w-3" />
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {source === "extensions" && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px]"
              disabled={reloading}
              onClick={() =>
                void (async () => {
                  setReloading(true);
                  setActionError(null);
                  try {
                    const fresh = await invokeCommand<PiindexEntry[]>("piindex_refresh");
                    setPiindex(fresh ?? []);
                  } catch (e) {
                    setActionError(String(e));
                  } finally {
                    setReloading(false);
                  }
                })()
              }
            >
              {reloading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              <span className="ml-0.5">{t("market.reload", "重新加载")}</span>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* v0.9.8 需求5（合并版）：市场推荐区——L1 画像命中时「为你推荐」动态
          组合卡；否则入门套装横滑（curated bundles 段，首启同款数据源）。 */}
      {source === "curated" && (recommendZone || bundles.length > 0) && (
        <div className="flex items-stretch gap-2 overflow-x-auto pb-0.5" data-bundle-row="">
          <span className="shrink-0 self-center text-[10px] text-muted-foreground">
            {t("market.bundleSection", "插件推荐")}
          </span>
          {recommendZone && (
            <button
              type="button"
              data-bundle-card="dynamic"
              onClick={() => {
                setBundleOpen({
                  id: "bundle-dynamic",
                  scene: "custom",
                  title: t("market.recommendForYou", "为你推荐"),
                  description: !recommendZone.note
                    ? t("market.recommendHint", "按最近任务挑选的组合")
                    : recommendZone.byWorkspace
                      ? t("market.recommendByProjectTask", { defaultValue: "根据项目特征：{{basis}}", basis: recommendZone.basis })
                      : t("market.recommendByTask", { defaultValue: "根据最近任务：{{note}}", note: recommendZone.note }),
                  items: recommendZone.items.map((e) => ({ ref: e.ref, required: false })),
                  dynamicNote: recommendZone.note,
                });
                // 自适应推荐卡默认全勾（agent 为任务挑的；微调是减法）。
                setBundleChecked(new Set(recommendZone.items.map((e) => e.ref)));
              }}
              className="shrink-0 rounded-lg border border-primary/60 bg-primary/10 px-3 py-1.5 text-left transition-colors"
            >
              <div className="text-xs font-medium text-foreground">
                {t("market.recommendForYou", "为你推荐")}
                <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                  {recommendZone.items.length} {t("market.bundleItems", { defaultValue: "{{n}} 项", n: "" })}
                </span>
              </div>
              <div className="max-w-64 truncate text-[10px] text-muted-foreground">
                {recommendZone.note || t("market.recommendHint", "按最近任务挑选的组合")}
              </div>
            </button>
          )}
          {bundles.map((b) => (
            <button
              key={b.id}
              type="button"
              data-bundle-card={b.scene}
              onClick={() => {
                setBundleOpen(b);
                // 入门套装默认勾必备（粗场景兜底；细分由自适应推荐承担）。
                setBundleChecked(new Set(b.items.filter((i) => i.required).map((i) => i.ref)));
              }}
              className={cn(
                "shrink-0 rounded-lg border px-3 py-1.5 text-left transition-colors",
                scene === b.scene
                  ? "border-primary/60 bg-primary/10"
                  : "border-border/60 hover:border-primary/40",
              )}
            >
              <div className="text-xs font-medium text-foreground">{b.title}</div>
              <div className="text-[10px] text-muted-foreground">
                {t("market.bundleItems", { defaultValue: "{{n}} 项", n: b.items.length })} · {b.description}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 工具行（十四轮 UI 统一，业界通行布局：筛选 chips 在左、搜索框恒
          最右、结构各页签恒定）：场景筛选（精选/技能）或分类筛选（扩展）；
          搜索三源统一——精选本地过滤 / 扩展在线库过滤 / 技能市场检索。 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 text-[10px]">
          {source !== "extensions"
            ? sceneTabs.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setScene(s.id);
                    setPage(1);
                  }}
                  className={cn(
                    "rounded-full border px-2 py-0.5 transition-colors",
                    scene === s.id
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border/60 text-muted-foreground hover:border-primary/40",
                  )}
                >
                  {s.label}
                </button>
              ))
            : extCategories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setExtCategory(c);
                    setExtPage(1);
                  }}
                  className={cn(
                    "rounded-full border px-2 py-0.5 transition-colors",
                    extCategory === c
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border/60 text-muted-foreground hover:border-primary/40",
                  )}
                >
                  {c === "all" ? t("market.sceneAll", "全部") : c}
                </button>
              ))}
        </div>
        <MarketSearchBox
          value={source === "skills" ? keyword : source === "extensions" ? onlineKw : curatedKw}
          onChange={(v) => {
            if (source === "skills") {
              setKeyword(v);
              setPage(1);
            } else if (source === "extensions") {
              setOnlineKw(v);
              setExtPage(1);
            } else {
              setCuratedKw(v);
            }
          }}
          placeholder={t("market.searchUnified", "搜索…")}
        />
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {actionError}
        </div>
      )}

      {/* v0.9.8 需求8 D8-1：后台拉到新目录的页内横幅（替代自动 reload 打断
          浏览）——点查看刷新列表；× 关闭不刷新（下次事件再提示）。 */}
      {catalogUpdated && (
        <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground">
          <span className="flex-1">{t("market.catalogUpdated", "市场目录已更新")}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() => {
              setCatalogUpdated(false);
              void load();
            }}
          >
            {t("market.catalogUpdatedView", "查看")}
          </Button>
          <button
            type="button"
            aria-label={t("market.catalogUpdatedDismiss", "关闭")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setCatalogUpdated(false)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          {source === "skills" ? t("market.skillNetworkError", "技能市场暂时不可用（网络）") : String(error)}
          <Button variant="outline" size="sm" className="ml-3 h-6 px-2 text-[10px]" onClick={() => void load()}>
            {t("market.retry", "重试")}
          </Button>
        </div>
      )}

      {/* 精选 */}
      {source === "curated" && !error && (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
          {curated
            .filter((e) => {
              const q = curatedKw.trim().toLowerCase();
              return !q || [e.title, e.description, e.id].join(" ").toLowerCase().includes(q);
            })
            .map((entry) => {
            const installed = installedIds.has(entry.id);
            return (
              <div
                key={entry.id}
                className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{entry.title}</span>
                  {entry.required && (
                    <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] text-muted-foreground">
                      {t("market.requiredBadge", "系统内置")}
                    </Badge>
                  )}
                </div>
                <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground" title={entry.description}>
                  {entry.description}
                </p>
                <div className="mt-auto flex items-center gap-1 pt-1">
                  {entry.scenes.length > 0 && (
                    <span className="text-[10px] text-muted-foreground/70">
                      {entry.scenes.map((s) => t(`scenes.${s}`, s)).join(" · ")}
                    </span>
                  )}
                  <span className="flex-1" />
                  {entry.required ? (
                    installed ? (
                      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Check className="h-3 w-3" />
                        {t("market.installed", "已安装")}
                      </span>
                    ) : null
                  ) : installed ? (
                    <>
                      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Check className="h-3 w-3" />
                        {t("market.installed", "已安装")}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive hover:text-destructive"
                        disabled={busyIds.has(entry.id)}
                        aria-label={t("market.uninstall", "卸载")}
                        title={t("market.uninstall", "卸载")}
                        onClick={() => void act(entry.id, "uninstall")}
                      >
                        {busyIds.has(entry.id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      disabled={busyIds.has(entry.id)}
                      onClick={() => void act(entry.id, "install")}
                    >
                      {busyIds.has(entry.id) ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Download className="h-3 w-3" />
                      )}
                      <span className="ml-0.5">{t("market.install", "安装")}</span>
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          {(curatedKw.trim()
            ? curated.filter((e) => {
                const q = curatedKw.trim().toLowerCase();
                return [e.title, e.description, e.id].join(' ').toLowerCase().includes(q);
              }).length === 0
            : curated.length === 0) &&
            !loading && (
            <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
              {t("market.curatedEmpty", "该场景暂无精选条目")}
            </p>
          )}
        </div>
      )}

      {/* 扩展生态 */}
      {source === "extensions" && !error && (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
          {extensions.map((pkg) => {
            const installed = installedIds.has(pkg.plugin_id);
            const required = installed && curated.find((c) => c.id === pkg.plugin_id)?.required;
            return (
              <div key={pkg.plugin_id} className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background p-3">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 shrink-0 text-primary/70" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={pkg.name}>
                    {pkg.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">v{pkg.version}</span>
                </div>
                <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{pkg.description}</p>
                <div className="mt-auto flex items-center gap-1 pt-1">
                  <span className="flex-1" />
                  {required ? (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                      {t("market.requiredBadge", "系统内置")}
                    </Badge>
                  ) : installed ? (
                    <>
                      <span className="text-[10px] text-muted-foreground">{t("market.installed", "已安装")}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive hover:text-destructive"
                        disabled={busyIds.has(pkg.plugin_id)}
                        aria-label={t("market.uninstall", "卸载")}
                        title={t("market.uninstall", "卸载")}
                        onClick={() => void act(pkg.plugin_id, "uninstall")}
                      >
                        {busyIds.has(pkg.plugin_id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      disabled={busyIds.has(pkg.plugin_id)}
                      onClick={() => void act(pkg.plugin_id, "install")}
                    >
                      {busyIds.has(pkg.plugin_id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                      <span className="ml-0.5">{t("market.install", "安装")}</span>
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* v0.9.8 需求8 A3：扩展目录慢载兜底（无缓存+拉取中：先加载中态，
          8s 后转「网络不佳」+重试；预拉取就位后仅首装首开可见）。
          D8-2：npm 兜底已有数据（online）时整块撤下——修前兜底出列表但
          转圈永挂；重试钮 8s 提示出现即允许点击（修前等 20s 超时+兜底
          全程约 40s 才可点）。 */}
      {source === "extensions" && !error && piindex === null && online === null && (
        <div className="flex flex-col items-center gap-2 py-10 text-xs text-muted-foreground" data-ext-loading="">
          {extSlow ? (
            <>
              <span>{t("market.extSlow", "网络不佳，目录加载较慢——可稍后重试")}</span>
              <Button size="sm" variant="outline" disabled={loading && !extSlow} onClick={() => void load()}>
                <RefreshCw className="h-3.5 w-3.5" />
                <span className="ml-1">{t("market.retry", "重试")}</span>
              </Button>
            </>
          ) : (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("market.extLoading", "目录加载中…")}
            </span>
          )}
        </div>
      )}

      {/* 扩展生态 · 在线库（需求3 补充：Pi Index 主源，npm 兜底） */}
      {source === "extensions" && !error && (piindex || online) && (
        <div>
          {/* 小节标题（工具行统一承载分类筛选与搜索——十四轮 UI 统一）。 */}
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            {piindex
              ? t("market.onlineLibPiindex", "在线扩展库（Pi Index）")
              : t("market.onlineLib", "在线扩展库")}
          </div>
          {/* Pi Index 目录卡片（主源；npm/git 源都可装——git 卡安装命令尾段即源） */}
          {piindex && (
            <>
              <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
                {pagedPiindex.map((entry) => {
                  // 安装源：npm 卡 npm:<pkg>；git 卡取安装命令尾段（git:github.com/…）。
                  const source = entry.npm_package
                    ? "npm:" + entry.npm_package
                    : entry.install_command.replace(/^pi install /, "");
                  const installed =
                    !!source &&
                    onlineInstalled.some((src) =>
                      source.startsWith("npm:")
                        ? src === source || src.startsWith(source + "@")
                        : // git 源 pi 落盘形态可能带 https:// 前缀——归一比对。
                          src === source || src === source.replace("git:github.com/", "git:https://github.com/"),
                    );
                  // 评审需求16：系统内置判定——catalog 命中即内置（对齐后端
                  // guard_uninstall_target 的 PI_PACKAGE_PLUGIN_MAP 全集口径；
                  // 修复轮回归收口：此前按「curated required」判，pi-lens 非
                  // required 却在内置集，会出现点了必报错的卸载钮）。
                  const builtin = installed && extensions.some(
                    (pkg) => installedSourceMatchesPiindex(pkg.source, entry),
                  );
                  // 需求15 方案 A：冲突停用态——本卡未注册但台账有（被某个
                  // 已装扩展顶掉）→ 显示「已停用（被 XX 替代）」；内置项不可
                  // 删除（只读提示），用户项可删除（复用卸载链，含台账清理）。
                  const pkgDirOf = (src: string) => {
                    const rest = src.replace(/^npm:/, "");
                    const at = rest.lastIndexOf("@");
                    return at > 0 ? rest.slice(0, at) : rest;
                  };
                  const overrideEntry = !installed && entry.npm_package
                    ? piOverrides.find((o) => pkgDirOf(o.source) === entry.npm_package)
                    : undefined;
                  return (
                    <div key={entry.name + (entry.github_url ?? "")} className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background p-3">
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4 shrink-0 text-primary/70" />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={entry.name}>{entry.name}</span>
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{entry.category}</span>
                      </div>
                      <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground" title={entry.description}>{entry.description || "-"}</p>
                      <div className="mt-auto flex items-center gap-1 pt-1 text-[10px] text-muted-foreground/70">
                        {/* 评审 P1-11 修复：悬浮提示直出中文改 t()。 */}
                        {entry.stars != null && (
                          <span className="inline-flex items-center gap-0.5" title={t("market.githubStars", "GitHub Star 数")}>
                            <Star className="h-3 w-3" />
                            {entry.stars}
                          </span>
                        )}
                        {entry.weekly_downloads != null && (
                          <span className="inline-flex items-center gap-0.5" title={t("market.npmWeeklyDownloads", "npm 每周下载量")}>
                            <ArrowDownToLine className="h-3 w-3" />
                            {formatCount(entry.weekly_downloads)}{t("market.perWeek", "/周")}
                            {entry.download_trend && <span className={trendClass(entry.download_trend)}>{entry.download_trend}</span>}
                          </span>
                        )}
                        <span className="flex-1" />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[10px] text-muted-foreground"
                          aria-label={t("market.detail", "详情")}
                          title={t("market.detail", "详情")}
                          onClick={() => setExtDetailEntry(entry)}
                        >
                          <Info className="h-3 w-3" />
                        </Button>

                        {/* 需求15 方案 A：冲突停用态呈现（内置/用户一致——说明被谁
                            替代；卸载替代者时自动恢复，此处只读）。 */}
                        {overrideEntry && (
                          <span
                            className="max-w-32 truncate text-[10px] text-amber-600/90"
                            title={t("market.overrideHint", {
                              defaultValue: "已停用：被 {{name}} 替代（卸载该扩展时自动恢复）",
                              name: pkgDirOf(overrideEntry.replaced_by),
                            })}
                          >
                            {t("market.overrideBadge", {
                              defaultValue: "已停用·被 {{name}} 替代",
                              name: pkgDirOf(overrideEntry.replaced_by),
                            })}
                          </span>
                        )}
                        {source && installed && (
                          <>
                            {/* 需求4 D4-8b：已装态界面行（登记簿驱动）+ D4-6
                                持久入口（新增适配；与引导卡同一预填链）。 */}
                            {(() => {
                              const entry = extGui.get(pkgKeyOf(source));
                              if (!entry || entry.state === "disabled") return null;
                              const launch = () =>
                                onLaunchDescribe?.(
                                  buildGuiAdaptDraft(t, { title: entry.display, packageName: pkgKeyOf(source) }),
                                );
                              return (
                                <span className="flex items-center gap-1 text-[9px] text-muted-foreground/80">
                                  <span>{t("market.extGuiLabel", "界面")}</span>
                                  {entry.adapters.length > 0 ? (
                                    <>
                                      <span className="max-w-[160px] truncate underline decoration-dotted" title={entry.adapters.map((a) => a.plugin_id).join("、")}>
                                        {entry.adapters.map((a) => a.plugin_id).join("、")}
                                      </span>
                                      <Button variant="outline" size="sm" className="h-4 px-1.5 text-[9px]" onClick={launch}>
                                        {t("market.addAdaptAction", "新增适配")}
                                      </Button>
                                    </>
                                  ) : entry.gui_verdict === "noneeded" || entry.gui_verdict === "session" ? (
                                    <span className="flex items-center gap-1" title={entry.verdict_note ?? undefined}>
                                      {entry.gui_verdict === "session"
                                        ? t("market.extGuiSession", "会话内呈现")
                                        : t("market.extGuiNotNeeded", "后台能力（无独立界面）")}
                                      <button
                                        type="button"
                                        className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                                        onClick={() => {
                                          void invokeCommand("extension_gui_verdict_set", {
                                            pkgKey: entry.pkg_key,
                                            verdict: "pending",
                                          })
                                            .catch(() => null)
                                            .then(() => refreshExtGui());
                                        }}
                                      >
                                        {t("market.extGuiReset", "重新判定")}
                                      </button>
                                    </span>
                                  ) : (
                                    <Button variant="outline" size="sm" className="h-4 px-1.5 text-[9px]" onClick={launch}>
                                      {t("market.adaptAction", "适配")}
                                    </Button>
                                  )}
                                </span>
                              );
                            })()}
                            <span className="text-muted-foreground">{t("market.installed")}</span>
                            {/* 评审需求16：在线生态卡已装项补卸载（系统内置除外
                                ——source 构造与安装同源 npm:/git:）。 */}
                            {!builtin && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-destructive hover:text-destructive"
                                disabled={busyIds.has(source)}
                                aria-label={t("market.uninstall", "卸载")}
                                title={t("market.uninstall", "卸载")}
                                onClick={() =>
                                  void (async () => {
                                    // 需求4 D4-8b：卸载双向提示——扩展被适配件
                                    // 使用时先确认（界面将停用）。
                                    const entry = extGui.get(pkgKeyOf(source));
                                    if (entry && entry.adapters.length > 0) {
                                      const ok = await confirmDialog({
                                        title: t("market.uninstall", "卸载"),
                                        description:
                                          t("market.uninstallExtDepsWarn", {
                                            defaultValue: "该扩展被 {{n}} 个界面插件使用：{{names}}——卸载后这些界面将停用",
                                            n: entry.adapters.length,
                                            names: entry.adapters.map((a) => a.plugin_id).join("、"),
                                          }),
                                        confirmText: t("market.uninstall", "卸载"),
                                        variant: "destructive",
                                      });
                                      if (!ok) return;
                                    }
                                    setActionError(null);
                                    setBusyIds((prev) => new Set(prev).add(source));
                                    try {
                                      await invokeCommand<string>("pi_package_uninstall_online", { source });
                                      await load();
                                      await refreshInstalled();
                                      await refreshExtGui();
                                      onChanged?.();
                                    } catch (e) {
                                      setActionError(String(e));
                                    } finally {
                                      setBusyIds((prev) => { const next = new Set(prev); next.delete(source); return next; });
                                    }
                                  })()
                                }
                              >
                                {busyIds.has(source) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                              </Button>
                            )}
                          </>
                        )}
                        {source && !installed && (
                          <Button
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            disabled={busyIds.has(source)}
                            onClick={() =>
                              void (async () => {
                                setActionError(null);
                                setBusyIds((prev) => new Set(prev).add(source));
                                try {
                                  // 安装走 pi 包管理器（npm/git 装载 + settings.json
                                  // 注册一步完成，装完 hub 提示启用）。
                                  const result = await invokeCommand<InstallOnlineOutcome>("pi_package_install_online", { source });
                                  const dispName = source.replace(/^npm:/, "").replace(/^git:.*\//, "");
                                  // 需求15 方案 A：工具名冲突（pi 原生拒绝启动，
                                  // hub 已回滚保健康态）→ 确认卡说明「与已装
                                  // 能力重叠」，用户选择继续（停用对手并安装）
                                  // 或取消（保持未装）。
                                  if (result.status === "conflict" && result.conflicts) {
                                    const overlap = result.conflicts
                                      .map((c) => t("market.conflictItem", {
                                        defaultValue: "「{{opponent}}」（工具 {{tool}}）",
                                        opponent: c.opponent_display,
                                        tool: c.tool,
                                      }))
                                      .join("、");
                                    const go = await confirmDialog({
                                      title: t("market.conflictTitle", { defaultValue: "能力重叠：{{name}}", name: dispName }),
                                      description: t("market.conflictDesc", {
                                        defaultValue:
                                          "该扩展与已装能力重叠：{{items}}。\n继续安装将停用上述扩展（内置项稍后卸载本扩展时自动恢复）；取消则不安装。",
                                        items: overlap,
                                      }),
                                      confirmText: t("market.conflictConfirm", "停用并安装"),
                                    });
                                    if (!go) {
                                      await load();
                                      return;
                                    }
                                    const confirmed = await invokeCommand<{ disabled: Array<{ opponent_display: string }>; }>(
                                      "pi_package_install_confirmed",
                                      { source },
                                    );
                                    const stopped = confirmed.disabled
                                      .map((d) => d.opponent_display)
                                      .join("、");
                                    const gs = await guiStateFor(source);
                                    setGuideCard({
                                      title: dispName,
                                      kind: "extension",
                                      description:
                                        t("market.guideExtensionDesc", "具备后台能力，装后经 GUI 适配生成界面插件") +
                                        (stopped ? `\n${t("market.conflictStopped", { defaultValue: "已停用：{{items}}（卸载本扩展时自动恢复）", items: stopped })}` : ""),
                                      packageName: source,
                                      guiAdaptable: !gs.providedBy && !gs.noneeded,
                                      providedBy: gs.providedBy,
                                    });
                                  } else {
                                    // v0.9.8 需求4：装后引导卡（扩展源）——GUI 适配入口。
                                    const gs = await guiStateFor(source);
                                    setGuideCard({
                                      title: dispName,
                                      kind: "extension",
                                      description: t("market.guideExtensionDesc", "具备后台能力，装后经 GUI 适配生成界面插件"),
                                      packageName: source,
                                      guiAdaptable: !gs.providedBy && !gs.noneeded,
                                      providedBy: gs.providedBy,
                                    });
                                  }
                                  refreshExtGui();
                                  await load();
                                  onChanged?.();
                                } catch (e) {
                                  setActionError(String(e));
                                } finally {
                                  setBusyIds((prev) => { const next = new Set(prev); next.delete(source); return next; });
                                }
                              })()
                            }
                          >
                            {busyIds.has(source) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                            <span className="ml-0.5">{t("market.install", "安装")}</span>
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {extTotal === 0 && (
                  <p className="col-span-full py-6 text-center text-xs text-muted-foreground">
                    {t("market.onlineEmpty", "没有匹配的扩展包")}
                  </p>
                )}
              </div>
              {extTotal > 0 && (
                <MarketPager
                  page={extPage}
                  pageCount={extPageCount}
                  total={extTotal}
                  pageSize={extPageSize}
                  onPage={setExtPage}
                  onPageSize={(n) => {
                    setExtPageSize(n);
                    setExtPage(1);
                  }}
                />
              )}
            </>
          )}
          {/* npm 检索兜底卡片（piindex 不可达时 online 非空才渲染） */}
          {online && (
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
            {online.slice(0, 12).map((pkg) => {
              const installed = onlineInstalled.some(
                (src) => src === "npm:" + pkg.name || src.startsWith("npm:" + pkg.name + "@"),
              );
              return (
                <div key={pkg.name} className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background p-3">
                  <div className="flex items-center gap-2">
                    <Package className="h-4 w-4 shrink-0 text-primary/70" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={pkg.name}>
                      {pkg.name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">v{pkg.version}</span>
                  </div>
                  <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground" title={pkg.description}>
                    {pkg.description || "-"}
                  </p>
                  <div className="mt-auto flex items-center gap-1 pt-1 text-[10px] text-muted-foreground/70">
                    {pkg.publisher && <span>@{pkg.publisher}</span>}
                    {pkg.date && <span>{pkg.date}</span>}
                    <span className="flex-1" />
                    {installed ? (
                      <>
                        <span className="text-muted-foreground">{t("market.installed")}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive hover:text-destructive"
                          disabled={busyIds.has(pkg.name)}
                          aria-label={t("market.uninstall", "卸载")}
                          title={t("market.uninstall", "卸载")}
                          onClick={() =>
                            void (async () => {
                              setActionError(null);
                              setBusyIds((prev) => new Set(prev).add(pkg.name));
                              try {
                                await invokeCommand<string>("pi_package_uninstall_online", { source: "npm:" + pkg.name });
                                await load();
                              } catch (e) {
                                setActionError(String(e));
                              } finally {
                                setBusyIds((prev) => { const next = new Set(prev); next.delete(pkg.name); return next; });
                              }
                            })()
                          }
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        disabled={busyIds.has(pkg.name)}
                        onClick={() =>
                          void (async () => {
                            setActionError(null);
                            setBusyIds((prev) => new Set(prev).add(pkg.name));
                            try {
                              await invokeCommand<string>("pi_package_install_online", {
                                source: "npm:" + pkg.name + "@" + pkg.version,
                              });
                              // v0.9.8 需求4：装后引导卡（扩展检索源）——GUI 适配入口
                              //（D4-8b：已适配重装态改示 providedBy；冲突结果消费归需求15 批）。
                              const gs = await guiStateFor("npm:" + pkg.name + "@" + pkg.version);
                              setGuideCard({
                                title: pkg.name,
                                kind: "extension",
                                description: pkg.description || t("market.guideExtensionDesc", "具备后台能力，装后经 GUI 适配生成界面插件"),
                                packageName: "npm:" + pkg.name + "@" + pkg.version,
                                guiAdaptable: !gs.providedBy && !gs.noneeded,
                                providedBy: gs.providedBy,
                              });
                              refreshExtGui();
                              await load();
                            } catch (e) {
                              setActionError(String(e));
                            } finally {
                              setBusyIds((prev) => { const next = new Set(prev); next.delete(pkg.name); return next; });
                            }
                          })()
                        }
                      >
                        {busyIds.has(pkg.name) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                        <span className="ml-0.5">{t("market.install", "安装")}</span>
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {online.length === 0 && (
              <p className="col-span-full py-6 text-center text-xs text-muted-foreground">
                {t("market.onlineEmpty", "没有匹配的扩展包")}
              </p>
            )}
          </div>
          )}
        </div>
      )}

      {/* 技能市场 */}
      {source === "skills" && !error && (
        <>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
            {(skills?.entries ?? []).map((skill) => {
              const installedVersion = skillInstalled[skill.slug];
              return (
                <div key={skill.slug} className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background p-3">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 shrink-0 text-primary/70" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={skill.name}>
                      {skill.name}
                    </span>
                    {skill.publisher_verified && (
                      <span title={t("market.verified", "认证发布者")}>
                        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                      </span>
                    )}
                  </div>
                  <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground" title={skill.description}>
                    {skill.description}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/80">
                    <span className="font-mono">{skill.slug}</span>
                    {skill.version && <span>v{skill.version}</span>}
                    {skill.score != null && (
                      <span className="inline-flex items-center gap-0.5">
                        <Star className="h-3 w-3" />
                        {formatCount(Number(skill.score))}
                      </span>
                    )}
                    {skill.requires_api_key && (
                      <span className="text-amber-600">{t("market.needsApiKey", "需要 API Key")}</span>
                    )}
                  </div>
                  <div className="mt-auto flex items-center gap-1 pt-1">
                    <span className="flex-1" />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[10px] text-muted-foreground"
                      onClick={() => void openSkillDetail(skill.slug)}
                      aria-label={t("market.detail", "详情")}
                      title={t("market.detail", "详情")}
                    >
                      <Info className="h-3 w-3" />
                    </Button>
                    {installedVersion ? (
                      <>
                        <span className="text-[10px] text-muted-foreground">
                          {t("market.installed")} v{installedVersion}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive hover:text-destructive"
                          disabled={busyIds.has(skill.slug)}
                          aria-label={t("market.uninstall", "卸载")}
                          title={t("market.uninstall", "卸载")}
                          onClick={() => void uninstallSkill(skill.slug)}
                        >
                          {busyIds.has(skill.slug) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        disabled={busyIds.has(skill.slug)}
                        onClick={() => void installSkill(skill)}
                      >
                        {busyIds.has(skill.slug) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                        <span className="ml-0.5">{t("market.install", "安装")}</span>
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {/* 分页（服务端分页 + 每页条数） */}
          <MarketPager
            page={skills?.page ?? 1}
            pageCount={Math.max(1, Math.ceil((skills?.total ?? 0) / skillPageSize))}
            total={skills?.total ?? 0}
            pageSize={skillPageSize}
            onPage={setPage}
            onPageSize={(n) => {
              setSkillPageSize(n);
              setPage(1);
            }}
            disabled={loading}
          />
        </>
      )}
      {/* 扩展详情弹窗（叹号入口——说明+查看来源）。 */}
      <Dialog open={!!extDetailEntry} onOpenChange={(open) => !open && setExtDetailEntry(null)}>
        <DialogContent className="max-w-md">
          {extDetailEntry ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-start gap-2">
                  <Package className="mt-0.5 h-4 w-4 shrink-0 text-primary/70" />
                  {/* 包名可能很长（@scope/pkg）——允许换行显示全名，不截断。 */}
                  <span className="min-w-0 break-all">{extDetailEntry.name}</span>
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p className="leading-relaxed text-muted-foreground">{extDetailEntry.description || "-"}</p>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {extDetailEntry.kind_label && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{extDetailEntry.kind_label}</span>
                  )}
                  {extDetailEntry.category && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{extDetailEntry.category}</span>
                  )}
                  {extDetailEntry.stars != null && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5">
                      <Star className="h-3 w-3" />
                      {extDetailEntry.stars}
                    </span>
                  )}
                  {extDetailEntry.weekly_downloads != null && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5">
                      <ArrowDownToLine className="h-3 w-3" />
                      {formatCount(extDetailEntry.weekly_downloads)}{t("market.perWeek", "/周")}
                      {extDetailEntry.download_trend && (
                        <span className={trendClass(extDetailEntry.download_trend)}>{extDetailEntry.download_trend}</span>
                      )}
                    </span>
                  )}
                </div>
                {(extDetailEntry.detail_url || extDetailEntry.github_url) && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() =>
                      void invokeCommand("open_url", {
                        // 查看来源优先 piindex（详情页/站内检索），目录缺卡才落 GitHub。
                        url: extDetailEntry.detail_url ?? extDetailEntry.github_url,
                      })
                    }
                  >
                    <ExternalLink className="h-3 w-3" />
                    <span className="ml-1">{t("market.viewSource", "查看来源")}</span>
                  </Button>
                )}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* 技能详情（需求3 补充） */}
      <Dialog open={skillDetailOpen} onOpenChange={setSkillDetailOpen}>
        <DialogContent className="max-w-md">
          {skillDetailLoading || !skillDetail ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-primary/70" />
                  {skillDetail.name}
                  <span className="font-mono text-xs text-muted-foreground">v{skillDetail.version}</span>
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p className="leading-relaxed text-muted-foreground">{skillDetail.description || "-"}</p>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {skillDetail.category && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{skillDetail.category}</span>
                  )}
                  {skillDetail.publisher_verified && (
                    <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600">{t("market.publisherVerified", "发布者已验证")}</span>
                  )}
                  {skillDetail.requires_api_key && (
                    <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600">{t("onboarding.needsKey", "需要 API Key")}</span>
                  )}
                </div>
                {skillDetail.publisher_name && (
                  <div className="text-xs text-muted-foreground/70">
                    {t("market.publisher", "发布者")}：{skillDetail.publisher_name}
                  </div>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => void invokeCommand("open_url", { url: `https://skillhub.cn/skills/${skillDetail.slug}` })}
                >
                  <ExternalLink className="h-3 w-3" />
                  <span className="ml-1">{t("market.viewSource", "查看来源")}</span>
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 技能安装确认弹窗（useConfirmDialog 契约：须渲染 dialogNode，否则
          confirm() 永不落定——点击安装无反应的根因）。 */}
      {confirmDialogNode}

      {/* v0.9.8 需求5（合并版）：套装/推荐详情弹层（勾选微调 + 共享执行器
          串行安装 + 汇总/重试/取消——五修全量生效）。 */}
      <Dialog
        open={bundleOpen !== null}
        onOpenChange={(o) => {
          // 五修①：running 期间禁关 ×（真取消走「取消剩余项」按钮——
          // 进行中单项任其完成，不留半装态）。
          if (!o && !bundleRunner.running) {
            setBundleOpen(null);
            // v0.9.8 评审修复轮 R1-7：运行结果属于弹层的**这一次打开**——关闭
            // 即结束本轮（结果清空）。此前结果一直留着：装完一个套装关掉
            // 再打开任何套装，页脚停在上次的汇总、没有安装入口，「重试失败
            // 项」重试的还是上一个套装的东西。
            bundleRunner.reset();
          }
        }}
      >
        <DialogContent className="max-w-md" data-bundle-dialog="">
          <DialogHeader>
            <DialogTitle>{bundleOpen?.title}</DialogTitle>
          </DialogHeader>
          <p className="-mt-1 text-xs text-muted-foreground">{bundleOpen?.description}</p>
          {/* 五修④：含技能项时的安全说明行（与单品安装披露口径对齐）。 */}
          {bundleOpen?.items.some((i) => i.ref.startsWith("skillhub:")) && (
            <p className="text-[10px] text-muted-foreground/80">
              {t("equip.skillSafetyNote", "技能项将安装到本地技能目录，已通过完整性校验")}
            </p>
          )}
          <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
            {bundleOpen?.items.map((item) => {
              const info = resolveBundleItem(item.ref);
              const st = bundleRunner.statuses.find((s) => s.ref === item.ref);
              const runState = st?.state;
              const checked = bundleChecked.has(item.ref);
              return (
                <label
                  key={item.ref}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-2.5 py-2",
                    // 需求15-F6：已装项与不可用项同权重化——勾选框虽 disabled
                    // 但形态与未装一致，用户会困惑「已装为何还能勾」。
                    info.unavailable || info.installed
                      ? "border-border/40 opacity-55"
                      : "border-border/60",
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                    checked={item.required || checked}
                    disabled={item.required || info.unavailable || runState === "running" || info.installed}
                    onChange={(e) =>
                      setBundleChecked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(item.ref);
                        else next.delete(item.ref);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs text-foreground">{info.title}</span>
                      <span className="shrink-0 font-mono text-[9px] text-amber-500">
                        {"★".repeat(Math.max(1, Math.min(5, info.stars)))}
                      </span>
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {info.kindName}
                      {item.required ? ` · ${t("market.bundleRequired", "必备")}` : ""}
                      {info.installed ? ` · ${t("market.installed", "已安装")}` : ""}
                      {info.unavailable ? ` · ${t("market.bundleUnavailable", "不可用")}` : ""}
                    </span>
                    {/* 五修③：失败原因可见（行内展开，前 200 字符）。 */}
                    {runState === "fail" && st?.error && (
                      <span className="mt-0.5 block max-h-16 overflow-y-auto break-all font-mono text-[9px] text-destructive/80">
                        {st.error.slice(0, 200)}
                      </span>
                    )}
                  </span>
                  {runState === "running" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
                  {runState === "ok" && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--icon-success)]" />}
                  {runState === "fail" && <X className="h-3.5 w-3.5 shrink-0 text-destructive" />}
                </label>
              );
            })}
          </div>
          {bundleRunner.statuses.length > 0 && !bundleRunner.running ? (
            (() => {
              const okCount = bundleRunner.statuses.filter((s) => s.state === "ok").length;
              const failed = bundleRunner.statuses.filter((s) => s.state === "fail");
              return (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t("market.bundleDone", {
                      defaultValue: "安装完成：成功 {{ok}} 项、失败 {{fail}} 项",
                      ok: okCount,
                      fail: failed.length,
                    })}
                  </span>
                  {/* 五修②：重试保历史（成功 ✓ 保留，仅失败项重置）。 */}
                  {failed.length > 0 && (
                    <Button size="sm" className="h-6 px-2 text-[10px]" onClick={() => bundleRunner.retryFailed()}>
                      {t("market.bundleRetryFailed", "重试失败项")}
                    </Button>
                  )}
                </div>
              );
            })()
          ) : bundleRunner.running ? (
            <div className="flex justify-end">
              {/* 五修①：真取消——剩余项不再发起，进行中单项任其完成。 */}
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => bundleRunner.cancel()}>
                {t("equip.cancelRemaining", "取消剩余项")}
              </Button>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={(() => {
                  if (!bundleOpen) return true;
                  const refs = bundleOpen.items
                    .filter((i) => i.required || bundleChecked.has(i.ref))
                    .filter((i) => !resolveBundleItem(i.ref).installed && !resolveBundleItem(i.ref).unavailable);
                  return refs.length === 0;
                })()}
                onClick={startBundleRun}
              >
                <Download className="h-3.5 w-3.5" />
                <span className="ml-1">
                  {(() => {
                    // 需求15-F7：全部已装时给终态文案，不再是「可点却逐项
                    // 跳过」的模糊态。
                    const allInstalled =
                      !!bundleOpen &&
                      bundleOpen.items.length > 0 &&
                      bundleOpen.items.every((i) => resolveBundleItem(i.ref).installed);
                    return allInstalled
                      ? t("market.bundleAllInstalled", "全部已安装")
                      : t("market.bundleInstall", "安装选中项");
                  })()}
                </span>
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>


      {/* v0.9.8 需求4：装后引导卡（三源统一，fixed toast 非阻断） */}
      {guideCard && (
        <InstallGuideCard
          info={guideCard}
          onNavigateConfig={onNavigateConfig}
          onGuiAdapt={
            onLaunchDescribe && guideCard.guiAdaptable
              ? () => onLaunchDescribe(buildGuiAdaptText(guideCard))
              : undefined
          }
          onClose={() => setGuideCard(null)}
        />
      )}
    </div>
  );
}
