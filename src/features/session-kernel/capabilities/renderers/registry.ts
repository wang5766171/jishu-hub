/** 渲染组件注册表（需求13：第三方绑定=唯一代码位；单例模块）。 */
import type { RendererRegistration } from "../types";

const registry = new Map<string, RendererRegistration>();

export const rendererRegistry = {
  register(reg: RendererRegistration): void {
    registry.set(reg.key, reg);
  },
  get(key: string): RendererRegistration | undefined {
    return registry.get(key);
  },
  list(): RendererRegistration[] {
    return [...registry.values()];
  },
};
