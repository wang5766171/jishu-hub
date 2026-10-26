/** 动作注册表（需求13：export-file/open-external/desktop-notify/clipboard/insert-composer/jump）。 */
import type { ActionHandler } from "../types";

const registry = new Map<string, ActionHandler>();

export const actionRegistry = {
  register(handler: ActionHandler): void {
    registry.set(handler.type, handler);
  },
  get(type: string): ActionHandler | undefined {
    return registry.get(type);
  },
  list(): ActionHandler[] {
    return [...registry.values()];
  },
};
