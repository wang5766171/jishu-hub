/**
 * v0.9.7 需求3 C2：插件市场面板（三源一套交互）。
 *
 * - 精选：curated.json（19 件 required「系统内置」+ 可选件可装可卸）+ 场景筛选。
 * - 扩展生态：pi npm 扩展包目录（钉版 5 包；启停与安装走同一执行面）。
 * - 技能市场：腾讯 SkillHub（场景分组/搜索/分页；安装前安全确认——
 *   来源/版本/发布者认证/是否需要密钥；装后各智能体立即可用）。
 * - 已装判定：精选/扩展 = plugin_list 交集；技能 = skillhub_installed 台账。
 * - 文案不暴露内部引擎代号（§7）：三源页签名为 精选/扩展生态/技能市场。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PLUGIN_SCENES } from "@/lib/plugin-scenes";
import { Bot, Check, Download, Loader2, Package, RefreshCw, Search, ShieldCheck, Sparkles, Trash2 } from "lucide-react";

interface MarketEntry {
  id: string;
  kind: string;
  title: string;
  description: string;
  category: string;
  scenes: string[];
  required: boolean;
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

const PAGE_SIZE = 20;

export function PluginMarketPanel({ onChanged }: { onChanged?: () => void }) {
  const { t } = useTranslation();
  const { confirm: confirmDialog } = useConfirmDialog();
  const [source, setSource] = useState<MarketSource>("curated");
  const [scene, setScene] = useState<string>("all");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);

  const [curated, setCurated] = useState<MarketEntry[]>([]);
  const [extensions, setExtensions] = useState<PiPackageEntry[]>([]);
  const [onlineKw, setOnlineKw] = useState("");
  const [online, setOnline] = useState<PiOnlinePackage[] | null>(null);
  const [onlineInstalled, setOnlineInstalled] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillhubListResult | null>(null);
  const [skillInstalled, setSkillInstalled] = useState<Record<string, string>>({});
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refreshInstalled = useCallback(async () => {
    try {
      const result = await invokeCommand<{ plugins: Array<{ id: string; enabled: boolean }> }>("plugin_list");
      setInstalledIds(new Set((result.plugins ?? []).map((p) => p.id)));
    } catch {
      /* plugin_list 失败保持当前值 */
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // curated 为内嵌数据（廉价）——三源共用（扩展生态的 required 判定也读它）。
      const sceneArg = scene === "all" ? null : scene;
      const curatedEntries = await invokeCommand<MarketEntry[]>("market_list_curated", {
        scene: source === "curated" ? sceneArg : null,
      });
      setCurated(curatedEntries ?? []);
      if (source !== "skills") {
        await refreshInstalled();
      }
      if (source === "extensions") {
        const entries = await invokeCommand<PiPackageEntry[]>("pi_package_catalog");
        setExtensions(entries ?? []);
        // 需求7 修1a：在线库（pi.dev 画廊同源 = npm pi-package keyword）。
        try {
          const [results, sources] = await Promise.all([
            invokeCommand<PiOnlinePackage[]>("pi_package_search", {
              keyword: onlineKw.trim() || null,
            }),
            invokeCommand<string[]>("pi_package_installed_sources"),
          ]);
          setOnline(results ?? []);
          setOnlineInstalled(sources ?? []);
        } catch (e) {
          setError(String(e));
        }
      } else if (source === "skills") {
        const kw = keyword.trim() || null;
        const result = await invokeCommand<SkillhubListResult>("skillhub_list", {
          scene: sceneArg,
          keyword: kw,
          page,
          pageSize: PAGE_SIZE,
        });
        setSkills(result);
        const installed = await invokeCommand<Record<string, string>>("skillhub_installed");
        setSkillInstalled(installed ?? {});
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [source, scene, keyword, page, onlineKw, refreshInstalled]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (id: string, action: "install" | "uninstall", confirm?: () => Promise<boolean>) => {
      if (busyId) return;
      if (confirm) {
        const ok = await confirm();
        if (!ok) return;
      }
      setActionError(null);
      setBusyId(id);
      try {
        const command = action === "install" ? "market_install" : "market_uninstall";
        await invokeCommand<string>(command, { pluginId: id });
        onChanged?.();
        await load();
      } catch (e) {
        setActionError(String(e));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, load, onChanged],
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
      if (busyId) return;
      setActionError(null);
      setBusyId(entry.slug);
      try {
        await invokeCommand<string>("skillhub_install", { slug: entry.slug });
        await load();
      } catch (e) {
        setActionError(String(e));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, confirmDialog, load, t],
  );

  const uninstallSkill = useCallback(
    async (slug: string) => {
      if (busyId) return;
      setActionError(null);
      setBusyId(slug);
      try {
        await invokeCommand<string>("skillhub_uninstall", { slug });
        await load();
      } catch (e) {
        setActionError(String(e));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, load],
  );

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
          {source !== "extensions" && (
            <div className="flex flex-wrap items-center gap-1 text-[10px]">
              {sceneTabs.map((s) => (
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
              ))}
            </div>
          )}
          {source === "skills" && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <input
                value={keyword}
                onChange={(e) => {
                  setKeyword(e.target.value);
                  setPage(1);
                }}
                placeholder={t("market.skillSearch", "搜索技能…")}
                className="h-7 w-44 rounded-md border border-border/60 bg-background pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground/50 focus:border-primary/50"
              />
            </div>
          )}
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {actionError}
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
          {curated.map((entry) => {
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
                        disabled={busyId === entry.id}
                        aria-label={t("market.uninstall", "卸载")}
                        onClick={() => void act(entry.id, "uninstall")}
                      >
                        {busyId === entry.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      disabled={busyId === entry.id}
                      onClick={() => void act(entry.id, "install")}
                    >
                      {busyId === entry.id ? (
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
          {curated.length === 0 && !loading && (
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
                        disabled={busyId === pkg.plugin_id}
                        aria-label={t("market.uninstall", "卸载")}
                        onClick={() => void act(pkg.plugin_id, "uninstall")}
                      >
                        {busyId === pkg.plugin_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      disabled={busyId === pkg.plugin_id}
                      onClick={() => void act(pkg.plugin_id, "install")}
                    >
                      {busyId === pkg.plugin_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                      <span className="ml-0.5">{t("market.install", "安装")}</span>
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 扩展生态 · 在线库（需求7 修1a） */}
      {source === "extensions" && !error && online && (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-muted-foreground">
              {t("market.onlineLib", "在线扩展库（pi 生态）")}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <input
                value={onlineKw}
                onChange={(e) => setOnlineKw(e.target.value)}
                placeholder={t("market.onlineSearch", "搜索扩展名…")}
                className="h-7 w-48 rounded-md border border-border/60 bg-background pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground/50 focus:border-primary/50"
              />
            </div>
          </div>
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
                          disabled={busyId === pkg.name}
                          aria-label={t("market.uninstall", "卸载")}
                          onClick={() =>
                            void (async () => {
                              setActionError(null);
                              setBusyId(pkg.name);
                              try {
                                await invokeCommand<string>("pi_package_uninstall_online", { name: pkg.name });
                                await load();
                              } catch (e) {
                                setActionError(String(e));
                              } finally {
                                setBusyId(null);
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
                        disabled={busyId === pkg.name}
                        onClick={() =>
                          void (async () => {
                            setActionError(null);
                            setBusyId(pkg.name);
                            try {
                              await invokeCommand<string>("pi_package_install_online", {
                                source: "npm:" + pkg.name + "@" + pkg.version,
                              });
                              await load();
                            } catch (e) {
                              setActionError(String(e));
                            } finally {
                              setBusyId(null);
                            }
                          })()
                        }
                      >
                        {busyId === pkg.name ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                        <span className="ml-0.5">{t("market.install", "安装")}</span>
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {online.length === 0 && (
              <p className="col-span-full py-6 text-center text-xs text-muted-foreground">
                {t("market.onlineEmpty", "没有匹配的 pi 扩展包")}
              </p>
            )}
          </div>
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
                    {skill.score != null && <span>★ {String(skill.score)}</span>}
                    {skill.requires_api_key && (
                      <span className="text-amber-600">{t("market.needsApiKey", "需要 API Key")}</span>
                    )}
                  </div>
                  <div className="mt-auto flex items-center gap-1 pt-1">
                    <span className="flex-1" />
                    {installedVersion ? (
                      <>
                        <span className="text-[10px] text-muted-foreground">
                          {t("market.installed")} v{installedVersion}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive hover:text-destructive"
                          disabled={busyId === skill.slug}
                          aria-label={t("market.uninstall", "卸载")}
                          onClick={() => void uninstallSkill(skill.slug)}
                        >
                          {busyId === skill.slug ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        disabled={busyId === skill.slug}
                        onClick={() => void installSkill(skill)}
                      >
                        {busyId === skill.slug ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                        <span className="ml-0.5">{t("market.install", "安装")}</span>
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {/* 分页 */}
          <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
            <Button variant="outline" size="sm" disabled={(skills?.page ?? 1) <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              {t("market.prevPage", "上一页")}
            </Button>
            <span>
              {skills?.page ?? 1} / {Math.max(1, Math.ceil((skills?.total ?? 0) / PAGE_SIZE))}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || (skills ? skills.page * PAGE_SIZE >= skills.total : true)}
              onClick={() => setPage((p) => p + 1)}
            >
              {t("market.nextPage", "下一页")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
