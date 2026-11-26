/**
 * 工具目录（@/lib/tool-catalog）的测试替身：测试直接设置目录内容，不走后端请求，
 * 也不听插件变更事件。目录模块自己的加载、重试、事件在 lib/tool-catalog.test.ts 里测。
 */
export const catalogStub = {
  names: {} as Record<string, string>,
  cats: {} as Record<string, string>,
  listeners: new Set<() => void>(),
  /** 有消费方用到目录时传进来的会话 id（按先后）。 */
  ensured: [] as (string | null)[],

  /** 换一份目录并通知订阅方。 */
  set(names: Record<string, string>, cats: Record<string, string> = {}): void {
    this.names = names;
    this.cats = cats;
    for (const listener of this.listeners) listener();
  },

  reset(): void {
    this.names = {};
    this.cats = {};
    this.listeners.clear();
    this.ensured.length = 0;
  },
};

export function getToolNames(): Record<string, string> {
  return catalogStub.names;
}

export function getToolCats(): Record<string, string> {
  return catalogStub.cats;
}

export function subscribeToolCatalog(listener: () => void): () => void {
  catalogStub.listeners.add(listener);
  return () => {
    catalogStub.listeners.delete(listener);
  };
}

export function ensureToolCatalog(sessionId: string | null): void {
  catalogStub.ensured.push(sessionId);
}

export function refreshToolCatalog(): Promise<void> {
  return Promise.resolve();
}
