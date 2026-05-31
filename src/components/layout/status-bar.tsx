import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import { invokeCommand } from "@/hooks/use-invoke";

interface StatusBarProps {
  projectCount: number;
}

export function StatusBar({ projectCount }: StatusBarProps) {
  const { t, i18n } = useTranslation();

  const toggleLanguage = async () => {
    const newLang = i18n.language === "zh" ? "en" : "zh";
    await i18n.changeLanguage(newLang);
    invokeCommand("save_language", { lang: newLang }).catch((e) => { if (import.meta.env.DEV) console.warn("IPC failed:", e); });
  };

  return (
    <footer className="flex items-center gap-4 border-t border-border bg-card px-4 py-1.5 text-xs text-muted-foreground">
      <span>{t("status.projects", { count: projectCount })}</span>
      <button
        onClick={toggleLanguage}
        className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent"
        title={i18n.language === "zh" ? "Switch to English" : "切换为中文"}
      >
        <Globe className="h-3 w-3" />
        {i18n.language === "zh" ? "EN" : "中"}
      </button>
    </footer>
  );
}
