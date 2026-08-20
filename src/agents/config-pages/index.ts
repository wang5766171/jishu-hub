import type { ComponentType, ReactNode } from "react";
import type { ConfigSurface, AgentStatus } from "../types";
import type { AgentConfigSection } from "@/types";
import { StructuredConfigPage } from "./structured";
import { ModelStoreConfigPage } from "./model-store";
import { RawConfigPage } from "./raw";
import { UnsupportedConfigPage } from "./unsupported";

/**
 * Common props for every adapter config page.
 * Each page is self-contained: it manages its own data loading,
 * state, and layout internally.
 */
export interface AdapterConfigPageProps {
  configSurface: ConfigSurface;
  activeAgent: AgentStatus | null;
  agentRefreshKey: number;
  /** v0.7.4 需求2 R4：智能体设置子页（模型/行为与权限/模板/高级）。 */
  configTab?: AgentConfigSection;
  /**
   * v0.7.0 需求一：智能体切换器插槽，渲染在配置页标题右边。
   * 由 ConfigPage 外壳注入（管理作用域 AgentSwitcher）。
   */
  switcherSlot?: ReactNode;
  /**
   * v0.7.6 需求2：跳转到指定智能体设置子页（模型页 env 块
   * 「前往高级设置修改」）。由 ConfigPage 外壳注入；未提供时相关
   * 跳转按钮隐藏（渐进降级）。
   */
  onNavigateSection?: (section: AgentConfigSection) => void;
}

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

// AdapterConfigPageProps is already exported via `export interface` above.
