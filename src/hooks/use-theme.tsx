import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { invokeCommand } from "@/hooks/use-invoke";

export type Theme = "light" | "colorful" | "dark";

const STORAGE_KEY = "jishu-hub-theme";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const validThemes: Theme[] = ["light", "colorful", "dark"];
    return stored && validThemes.includes(stored as Theme) ? (stored as Theme) : "dark";
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Load persisted theme from backend on mount
  useEffect(() => {
    invokeCommand<string>("load_theme").then((t) => {
      if (t && ["light", "colorful", "dark"].includes(t)) {
        setThemeState(t as Theme);
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
