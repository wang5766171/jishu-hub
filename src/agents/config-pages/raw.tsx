import { useTranslation } from "react-i18next";
import { useInvoke } from "@/hooks/use-invoke";
import { RawConfigEditor } from "@/components/config/raw-config-editor";
import { Skeleton } from "@/components/ui/skeleton";
import type { AdapterConfigPageProps } from "./index";

interface RawConfigInfo {
  content: string;
  format: string;
}

/**
 * Config page for agents with raw (text-file) configuration.
 * Renders a monaco-style editor with the raw file content.
 */
export function RawConfigPage({ activeAgent, agentRefreshKey }: AdapterConfigPageProps) {
  const { t } = useTranslation();
  const { data: rawConfig, loading, refetch } = useInvoke<RawConfigInfo>(
    "load_raw_config",
    undefined,
    agentRefreshKey,
  );

  if (loading || !rawConfig) {
    return <Skeleton className="h-64" />;
  }

  return (
    <div className="flex flex-col h-full p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{t("config.title")}</h2>
          {activeAgent && (
            <p className="mt-1 text-xs text-muted-foreground">
              {activeAgent.display_name}
            </p>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {t("config.nativeFormatHint")}
        </p>
      </div>
      <div className="flex-1 min-h-0">
        <RawConfigEditor
          initialContent={rawConfig.content}
          format={rawConfig.format}
          onSaved={refetch}
        />
      </div>
    </div>
  );
}
