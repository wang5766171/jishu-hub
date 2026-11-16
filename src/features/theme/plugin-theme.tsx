/**
 * 需求14 M2（S3 外观能力点）：主题插件装载器——应用级消费（非会话挂载臂）。
 *
 * 装载链（R3-b 裁决）：组合引擎把 [theme] 声明透传到描述符（app-theme
 * 挂载无 mounts）→ 本装载器按激活记忆（state.theme = 插件 id，B5 单真源）
 * 找到启用中的主题插件 → 经 plugin_read_file 后端读 css（CSP style-src
 * 无 asset 源，`<link>` 会被拦；内联 `<style>` 走 'unsafe-inline' 且天然
 * 保证级联顺序在打包 CSS 之后）→ 注入 + 设 data-jishu-theme 选择器属性
 * 与 data-theme 基座属性（dark:/colorful: variant 工具类依赖基座）。
 *
 * 回落纪律（v0.9.6 需求7 修正）：装载未就绪不判定；插件缺失/禁用/装载
 * 失败 → 仅内存回落内置 dark（setThemeTransient，不写盘——启动竞态/装载
 * 窗口曾把「暂时找不到」当「真找不到」持久化回落，用户主题被偶发还原）；
 * 持久化回落只保留用户显式操作路径（外观页选/删主题）。激活成功幂等回写
 * save_theme（自愈历史暗伤）。
 */
import { useEffect, useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTheme, isBuiltinTheme } from "@/hooks/use-theme";
import { invokeCommand } from "@/hooks/use-invoke";
import { devLog } from "@/lib/dev-log";
import { listSessionPlugins } from "@/features/session-kernel/plugins/registry";
import {
  composedReady,
  composedVersion,
  subscribeComposed,
} from "@/features/session-kernel/capabilities/composition/loader";

const STYLE_MARK = "data-jishu-plugin-theme";

/** 公开令牌契约（02 §4.1 子集，逐名——B14：两段命名并存防写错）。 */
const THEME_TOKEN_ALLOWLIST = new Set([
  "--color-background",
  "--color-layer-0",
  "--color-layer-1",
  "--color-layer-2",
  "--color-layer-3",
  "--color-layer-4",
  "--message-user-bg",
  "--message-assistant-bg",
  "--message-thinking-bg",
]);

/** 需求14 M2（02 §4.2）：令牌越权提醒——css 引用契约外 `--var` 给 warning
 *  不阻塞（非契约样式不保证跨版本；dev 控制台可见，用户侧无感）。 */
export function warnOutOfContractTokens(css: string, pluginId: string): void {
  const used = new Set([...css.matchAll(/--([a-z0-9-]+)/gi)].map((m) => `--${m[1].toLowerCase()}`));
  const stray = [...used].filter((v) => !THEME_TOKEN_ALLOWLIST.has(v));
  if (stray.length > 0) {
    console.warn(
      `[plugin-theme] ${pluginId}: theme.css 引用了契约外变量（不保证跨版本生效）：${stray.join(", ")}`,
    );
  }
}

function cleanupPluginTheme(): void {
  document.querySelectorAll(`style[${STYLE_MARK}]`).forEach((el) => el.remove());
  document.documentElement.removeAttribute("data-jishu-theme");
}

/** 背景图等 css 资产记号展开：内联注入后相对 url() 会按页面基址解析（R3-b
 *  的连带坑）——约定 theme.css 内以 `url(@file:bg.jpg)` 引用插件目录资产
 * （与清单 @file: 记号同构），注入前展开为 asset 协议绝对 URL（img-src
 *  CSP 已含 asset:）。dir 用反斜杠归一（asset scope 正斜杠匹配，同
 *  hybrid-runtime buildAssetUrl 纪律）。toUrl 可注入（vitest 替身）。 */
export function expandThemeAssetUrls(
  content: string,
  dir: string,
  toUrl: (path: string) => string = convertFileSrc,
): string {
  return content.replace(/url\(\s*@file:([^)]+?)\s*\)/g, (_m, rel: string) => {
    const normalized = `${dir.replace(/\\/g, "/")}/${String(rel).trim()}`;
    return `url("${toUrl(normalized)}")`;
  });
}

/** App 根部调用一次（ThemeProvider 内）；订阅组合清单版本实现 css 热更。 */
export function usePluginTheme(): void {
  const { theme, setTheme, setThemeTransient } = useTheme();
  const version = useSyncExternalStore(subscribeComposed, composedVersion, () => 0);

  useEffect(() => {
    let cancelled = false;
    if (isBuiltinTheme(theme)) {
      // 内置档：清插件痕迹（基座 data-theme 由 use-theme.applyTheme 设置）。
      cleanupPluginTheme();
      return;
    }
    // v0.9.6 需求7 F1：组合清单未装载完成不判定——避免启动竞态把「暂时找不
    // 到」当「真找不到」（cache 初始为空，装载完成 version++ 会重跑本 effect）。
    if (!composedReady()) {
      devLog("capability", "theme activation deferred: composed manifests not ready", { requested: theme });
      return;
    }
    const descriptor = listSessionPlugins().find((p) => p.id === theme && p.theme);
    if (!descriptor?.theme) {
      devLog("capability", `theme fallback: ${theme} not found → dark (transient, not persisted)`, { requested: theme, reason: "descriptor-missing" });
      setThemeTransient("dark");
      return;
    }
    const decl = descriptor.theme;
    const rel = decl.css.replace(/^@file:/, "");
    void (async () => {
      try {
        // 启用态检查（loader 对纯清单组合件不做启用过滤——此处显式查）。
        const list = await invokeCommand<{
          plugins: Array<{ id: string; enabled: boolean }>;
        }>("plugin_list");
        if (cancelled) return;
        const enabled = (list.plugins ?? []).some((p) => p.id === theme && p.enabled);
        if (!enabled) {
          devLog("capability", `theme fallback: ${theme} disabled → dark (transient, not persisted)`, { requested: theme, reason: "disabled" });
          setThemeTransient("dark");
          return;
        }
        const r = await invokeCommand<{ path: string; content: string }>(
          "plugin_read_file",
          { pluginId: theme, file: rel },
        );
        if (cancelled) return;
        cleanupPluginTheme();
        const style = document.createElement("style");
        style.setAttribute(STYLE_MARK, theme);
        // 资产记号展开（dir = css 文件所在目录；只认 _files 浅层资产——与
        // 主题插件「资产平铺」纪律一致，越界形态经此处也仅能命中目录内文件）。
        const dir = r.path.replace(/[\\/][^\\/]+$/, "");
        style.textContent = expandThemeAssetUrls(r.content, dir);
        document.head.appendChild(style);
        document.documentElement.setAttribute("data-jishu-theme", theme);
        // 基座属性（base 归一化非空，engine 缺省 dark）。
        document.documentElement.setAttribute("data-theme", decl.base);
        devLog("capability", `theme activated: ${theme} (base=${decl.base}, css=${r.content.length}B)`, { themeId: theme, base: decl.base });
        // v0.9.6 需求7 F3：激活成功幂等回写——自愈历史暗伤（state.theme 曾被
        // 竞态回落写成 dark，load 水合又不回写；此处同值 save 无副作用）。
        setTheme(theme);
      } catch (e) {
        if (!cancelled) {
          devLog("capability", `theme load failed: ${theme} → dark (transient, not persisted)`, { requested: theme, error: String(e).slice(0, 120) });
          setThemeTransient("dark");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [theme, setTheme, setThemeTransient, version]);
}
