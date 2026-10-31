import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { invokeCommand } from "@/hooks/use-invoke";

/** 内置基座三档（data-theme 属性 / 标题栏循环切换的范围）。 */
export type BuiltinTheme = "light" | "colorful" | "dark";

/** 主题值（需求14 M2/B5 扩展）：内置三档 **或** 主题插件 id（激活记忆走
 * state.theme 值域扩展——后端 hub state 单值字段天然互斥且启动早装载，
 * 弃用原 per-plugin 行为键方案；localStorage 镜像同步）。
 * 字面量联合之外的 string 用于插件 id（非穷举），消费侧用 isBuiltinTheme 收窄。 */
export type Theme = BuiltinTheme | (string & {});

const STORAGE_KEY = "jishu-hub-theme";

const BUILTIN_THEMES: BuiltinTheme[] = ["light", "colorful", "dark"];

export function isBuiltinTheme(t: string): t is BuiltinTheme {
  return (BUILTIN_THEMES as string[]).includes(t);
}

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function applyTheme(theme: Theme) {
  // 内置档：直接设基座属性；插件主题：基座属性与 data-jishu-theme 由
  // plugin-theme 装载器管理（css 依赖插件目录文件，须异步装载）。
  if (isBuiltinTheme(theme)) {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    // 内置三档 or 主题插件 id（启动快照；插件缺失/禁用由装载器回落处理）。
    return stored && stored.trim() ? stored : "dark";
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Load persisted theme from backend on mount
  useEffect(() => {
    invokeCommand<string>("load_theme").then((t) => {
      if (t && t.trim()) {
        setThemeState(t);
        localStorage.setItem(STORAGE_KEY, t);
      }
    }).catch((e) => { if (import.meta.env.DEV) console.warn("IPC failed:", e); });
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    localStorage.setItem(STORAGE_KEY, t);
    invokeCommand("save_theme", { theme: t }).catch((e) => { if (import.meta.env.DEV) console.warn("IPC failed:", e); });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
