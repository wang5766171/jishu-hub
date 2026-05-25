import { useState, useEffect, useCallback } from "react";
import { invokeCommand } from "@/hooks/use-invoke";

export type FontLevel = "s" | "m" | "l" | "xl";

const STORAGE_KEY_BASE = "jishu-hub-font-size-base";
const STORAGE_KEY_PROSE = "jishu-hub-font-size-prose";

const BASE_MAP: Record<FontLevel, string> = { s: "15px", m: "19px", l: "23px", xl: "27px" };
const PROSE_MAP: Record<FontLevel, string> = { s: "12px", m: "15px", l: "18px", xl: "21px" };

function applyFontSize(base: FontLevel, prose: FontLevel) {
  // Set fontSize directly on root to trigger CSS transition (CSS variable changes are instant)
  document.documentElement.style.fontSize = BASE_MAP[base];
  document.documentElement.style.setProperty("--font-size-prose", PROSE_MAP[prose]);
}

export function useFontSize() {
  const [fontSizeBase, setFontSizeBaseState] = useState<FontLevel>(() => {
    return (localStorage.getItem(STORAGE_KEY_BASE) as FontLevel) || "m";
  });
  const [fontSizeProse, setFontSizeProseState] = useState<FontLevel>(() => {
    return (localStorage.getItem(STORAGE_KEY_PROSE) as FontLevel) || "m";
  });

  useEffect(() => {
    applyFontSize(fontSizeBase, fontSizeProse);
  }, [fontSizeBase, fontSizeProse]);

  useEffect(() => {
    invokeCommand<[string | null, string | null]>("load_font_sizes").then(([base, prose]) => {
      if (base && ["s", "m", "l", "xl"].includes(base)) {
        setFontSizeBaseState(base as FontLevel);
        localStorage.setItem(STORAGE_KEY_BASE, base);
      }
      if (prose && ["s", "m", "l", "xl"].includes(prose)) {
        setFontSizeProseState(prose as FontLevel);
        localStorage.setItem(STORAGE_KEY_PROSE, prose);
      }
    }).catch(() => {});
  }, []);

  const setFontSizeBase = useCallback((level: FontLevel) => {
    setFontSizeBaseState(level);
    localStorage.setItem(STORAGE_KEY_BASE, level);
    invokeCommand("save_font_sizes", { fontSizeBase: level, fontSizeProse: fontSizeProse }).catch(() => {});
  }, [fontSizeProse]);

  const setFontSizeProse = useCallback((level: FontLevel) => {
    setFontSizeProseState(level);
    localStorage.setItem(STORAGE_KEY_PROSE, level);
    invokeCommand("save_font_sizes", { fontSizeBase: fontSizeBase, fontSizeProse: level }).catch(() => {});
  }, [fontSizeBase]);

  return { fontSizeBase, fontSizeProse, setFontSizeBase, setFontSizeProse };
}
