import type { ComponentType } from "react";
import type { ConfigSurface } from "../types";
import { StructuredConfigPage } from "./structured";
import { ModelStoreConfigPage } from "./model-store";
import { RawConfigPage } from "./raw";
import { UnsupportedConfigPage } from "./unsupported";

/**
 * Common props for every adapter config page.
 * Each page is self-contained: it manages its own data loading,
 * state, tabs, and layout internally.
 */
export interface AdapterConfigPageProps {
  configSurface: ConfigSurface;
  activeAgent: AgentInfo | null;
  agentRefreshKey: number;
  initialTab?: "edit" | "templates" | "backups";
}

import type { AgentInfo } from "../types";

type ConfigSurfaceKind = ConfigSurface["kind"];

const registry: Record<ConfigSurfaceKind, ComponentType<AdapterConfigPageProps>> = {
  structured: StructuredConfigPage,
  model_store: ModelStoreConfigPage,
  raw: RawConfigPage,
  unsupported: UnsupportedConfigPage,
};

/**
 * Returns the adapter config page component for the given ConfigSurface kind.
 */
export function getAdapterConfigPage(kind: ConfigSurfaceKind) {
  return registry[kind];
}

export type { AdapterConfigPageProps };
