import { useTranslation } from "react-i18next";
import type { AdapterConfigPageProps } from "./index";

/**
 * Fallback config page for agents that do not support configuration.
 */
export function UnsupportedConfigPage({}: AdapterConfigPageProps) {
  const { t } = useTranslation();
  return <div className="text-muted-foreground">{t("config.loadFailed")}</div>;
}
