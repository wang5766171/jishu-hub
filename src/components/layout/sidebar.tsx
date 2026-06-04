import { FolderOpen, Settings, Pin, PinOff } from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { getVersion } from "@tauri-apps/api/app";
import type { Page } from "@/types";

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

type NavPage = "chat" | "manage";

const navItems: { page: NavPage; icon: typeof FolderOpen; labelKey: string }[] = [
  { page: "chat", icon: FolderOpen, labelKey: "nav.sessions" },
  { page: "manage", icon: Settings, labelKey: "nav.config" },
];

export function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const { t } = useTranslation();
  const [pinned, setPinned] = useState(false);
  const [version, setVersion] = useState("");

  useEffect(() => {
    invokeCommand<boolean>("load_always_on_top").then(setPinned).catch(console.error);
    getVersion().then((v) => setVersion(v)).catch(() => setVersion("unknown"));
  }, []);

  const handleToggle = async () => {
    try {
      const newValue = await invokeCommand<boolean>("toggle_always_on_top");
      setPinned(newValue);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <aside className="flex w-52 flex-col border-r border-border bg-card">
      <div className="border-b border-border p-4">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">Jishu Hub</h1>
          <button
            onClick={handleToggle}
            className={cn(
              "h-5 w-5 flex items-center justify-center rounded hover:bg-accent/50 transition-colors",
              pinned && "text-primary"
            )}
            title={pinned ? "取消置顶" : "置顶窗口"}
          >
            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">{version ? `v${version}` : ""}</p>
      </div>
      <nav className="flex-1 p-2">
        {navItems.map(({ page, icon: Icon, labelKey }) => (
          <button
            key={page}
            data-page={page}
            onClick={() => onNavigate(page)}
            className={cn(
              "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              currentPage === page
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4" />
            {t(labelKey)}
          </button>
        ))}
      </nav>
    </aside>
  );
}
