/**
 * `@earendil-works/pi-ai` 测试替身（vitest 别名指向本文件）。
 * pi 扩展源码（src-tauri/resources/extensions/*.ts）引用该包的 Type 构建
 * 参数 schema——契约测试只断言工具返回形状，schema 本体无关断言，
 * 用 Proxy 生成占位构建器即可。
 */
export const Type: ProxyHandler<Record<string, unknown>> = new Proxy(
  {},
  {
    get: (_target, prop) =>
      (...args: unknown[]) =>
        ({ kind: String(prop), args }),
  },
) as never;
