import { describe, expect, it } from "vitest";
import { validateManifest, type RendererRegistration, type SessionComposedManifest } from "./types";

const renderers = {
  get: (key: string): RendererRegistration | undefined =>
    key === "render.divider" || key === "render.list"
      ? { key, component: () => null }
      : undefined,
};

function manifest(overrides: {
  source?: Partial<SessionComposedManifest["source"]>;
  mount?: string;
}): SessionComposedManifest {
  const source = overrides.source ?? { type: "block-type", blockTypes: ["phase_divider"] };
  return {
    plugin: { id: "test.plugin", name: "测试" },
    kind: "session-composed",
    source: source as SessionComposedManifest["source"],
    render: { component: "render.divider", mount: overrides.mount ?? "block-renderer" },
  };
}

describe("validateManifest（source×mount 配对矩阵，测试期修复23 契约收口）", () => {
  it("合法配对通过（六个内置清单形状）", () => {
    // mermaid-render：code-block + block-renderer
    expect(
      validateManifest(manifest({ source: { type: "code-block", languages: ["mermaid"] } }), renderers),
    ).toEqual([]);
    // phase-divider：block-type + block-renderer
    expect(validateManifest(manifest({}), renderers)).toEqual([]);
    // outline：turns + dock-panel
    expect(
      validateManifest(manifest({ source: { type: "turns" }, mount: "dock-panel" }), renderers),
    ).toEqual([]);
    // tool-stats：messages + dock-panel
    expect(
      validateManifest(manifest({ source: { type: "messages" }, mount: "dock-panel" }), renderers),
    ).toEqual([]);
    // navigation：turns + rail-widget
    expect(
      validateManifest(manifest({ source: { type: "turns" }, mount: "rail-widget" }), renderers),
    ).toEqual([]);
    // desktop-notify：signal + event-hook
    expect(
      validateManifest(manifest({ source: { type: "signal" }, mount: "event-hook" }), renderers),
    ).toEqual([]);
    // task-board（C5-slice1）：task + dock-panel
    expect(
      validateManifest(manifest({ source: { type: "task" }, mount: "dock-panel" }), renderers),
    ).toEqual([]);
  });

  it("@file: 混合插件规则（需求25 P1 + 需求14 M1 解禁）：代码就绪 + block-renderer 放开 + 无导出动作", () => {
    const fileManifest = manifest({
      source: { type: "messages" },
      mount: "dock-panel",
    });
    const withFile = {
      ...fileManifest,
      render: { ...fileManifest.render, component: "@file:component.js" },
    } as typeof fileManifest;
    // 未就绪 → 拒绝；就绪 → 通过。
    expect(validateManifest(withFile, renderers).some((e) => e.includes("代码组件未就绪"))).toBe(true);
    expect(validateManifest(withFile, renderers, { fileComponentReady: true })).toEqual([]);
    // 需求14 M1（02 §3.1）：block-renderer 解禁——代码就绪 + code-block 源
    //（languages 显式）即可通过。
    const boardMount = {
      ...withFile,
      source: { type: "code-block", languages: ["echarts"] },
      render: { ...withFile.render, mount: "block-renderer" },
    } as typeof withFile;
    expect(validateManifest(boardMount, renderers, { fileComponentReady: true })).toEqual([]);
    // export-file 禁令维持（02 §13-6 方案 b：代码组件无注册表 toFile 通道）。
    const withExport = { ...withFile, action: [{ type: "export-file", format: "png" }] } as typeof withFile;
    expect(validateManifest(withExport, renderers, { fileComponentReady: true }).some((e) => e.includes("export-file"))).toBe(true);
    // Rust 扫描注入的文件存在性错误透出。
    const missing = { ...withFile, _file_error: "代码文件不存在: component.js" } as typeof withFile;
    expect(validateManifest(missing, renderers, { fileComponentReady: true }).some((e) => e.includes("代码文件不存在"))).toBe(true);
  });

  it("fallback 键校验（需求14 M1 B1）：未注册/ @file: 拒绝，已注册通过", () => {
    const base = manifest({ source: { type: "code-block", languages: ["echarts"] } });
    // 未注册键 → fail loud（typo 装载期暴露）。
    const badKey = { ...base, render: { ...base.render, fallback: "render.no-such" } } as typeof base;
    expect(validateManifest(badKey, renderers).some((e) => e.includes("回退渲染组件未注册"))).toBe(true);
    // fallback 不接受 @file:（须为内置渲染键）。
    const fileFallback = { ...base, render: { ...base.render, fallback: "@file:fallback.js" } } as typeof base;
    expect(validateManifest(fileFallback, renderers).some((e) => e.includes("fallback 不支持 @file:"))).toBe(true);
    // 已注册键通过。
    const ok = { ...base, render: { ...base.render, fallback: "render.list" } } as typeof base;
    expect(validateManifest(ok, renderers)).toEqual([]);
  });

  it("task 源只配停靠/边栏挂载（C5-slice1 矩阵扩展）", () => {
    for (const mount of ["block-renderer", "rail-widget", "composer-trailing", "event-hook"]) {
      const errors = validateManifest(manifest({ source: { type: "task" }, mount }), renderers);
      expect(errors.some((e) => e.includes(`mount ${mount} 不接受源类型 task`))).toBe(true);
    }
  });

  it("数据面源配 block-renderer 拒绝（turns 劫持一切代码块的同源洞）", () => {
    const errors = validateManifest(
      manifest({ source: { type: "turns", blockTypes: undefined }, mount: "block-renderer" }),
      renderers,
    );
    expect(errors.some((e) => e.includes("block-renderer 不接受源类型 turns"))).toBe(true);
  });

  it("block-type 源配数据面/事件挂载拒绝（静默无意义载荷洞）", () => {
    for (const mount of ["dock-panel", "rail-widget", "composer-trailing", "event-hook"]) {
      const errors = validateManifest(manifest({ mount }), renderers);
      expect(errors.some((e) => e.includes(`mount ${mount} 不接受源类型 block-type`))).toBe(true);
    }
  });

  it("signal 源配渲染挂载拒绝", () => {
    const errors = validateManifest(
      manifest({ source: { type: "signal" }, mount: "block-renderer" }),
      renderers,
    );
    expect(errors.some((e) => e.includes("block-renderer 不接受源类型 signal"))).toBe(true);
  });

  it("未知 mount 拒绝", () => {
    const errors = validateManifest(manifest({ mount: "nowhere" }), renderers);
    expect(errors.some((e) => e.includes("mount 非法"))).toBe(true);
  });

  it("源域字段互斥：block-type 不得声明 languages / code-block 不得声明 blockTypes", () => {
    expect(
      validateManifest(
        manifest({ source: { type: "block-type", blockTypes: ["phase_divider"], languages: ["mermaid"] } }),
        renderers,
      ).some((e) => e.includes("不得声明 languages")),
    ).toBe(true);
    expect(
      validateManifest(
        manifest({ source: { type: "code-block", languages: ["mermaid"], blockTypes: ["phase_divider"] } }),
        renderers,
      ).some((e) => e.includes("不得声明 blockTypes")),
    ).toBe(true);
  });

  it("源域显式格式必填：block-type 需 blockTypes / code-block 需 languages", () => {
    expect(
      validateManifest(manifest({ source: { type: "block-type" } }), renderers).some((e) =>
        e.includes("block-type 需声明 blockTypes"),
      ),
    ).toBe(true);
    expect(
      validateManifest(manifest({ source: { type: "code-block", languages: [] } }), renderers).some((e) =>
        e.includes("code-block 需声明 languages"),
      ),
    ).toBe(true);
  });
});

describe("需求14 M2：app-theme 挂载与 [theme] 段校验（B6 无源门控）", () => {
  const themeRenderers = renderers; // 同文件注册表替身（theme 形态不查组件键）
  const themeManifest = (): SessionComposedManifest =>
    ({
      plugin: { id: "session.theme-x", name: "主题X" },
      kind: "session-composed",
      theme: { css: "@file:theme.css", base: "dark", preview: ["#000", "#fff"] },
      render: { component: "", mount: "app-theme" },
    }) as unknown as SessionComposedManifest;

  it("合法主题清单通过：无 source（B6 门控）+ component 豁免", () => {
    expect(validateManifest(themeManifest(), themeRenderers)).toEqual([]);
  });

  it("app-theme 带 source 拒绝（矩阵行空集）", () => {
    const m = { ...themeManifest(), source: { type: "messages" } } as unknown as SessionComposedManifest;
    expect(validateManifest(m, themeRenderers).some((e) => e.includes("不接受源类型"))).toBe(true);
  });

  it("theme 段三重校验：css 须 @file: / base 三档枚举 / 必须配 app-theme", () => {
    const badCss = { ...themeManifest(), theme: { css: "theme.css" } } as unknown as SessionComposedManifest;
    expect(validateManifest(badCss, themeRenderers).some((e) => e.includes("css 必须为 @file:"))).toBe(true);
    const badBase = { ...themeManifest(), theme: { css: "@file:theme.css", base: "neon" } } as unknown as SessionComposedManifest;
    expect(validateManifest(badBase, themeRenderers).some((e) => e.includes("base 非法"))).toBe(true);
    const wrongMount = { ...themeManifest(), render: { component: "render.list", mount: "dock-panel" } } as unknown as SessionComposedManifest;
    expect(validateManifest(wrongMount, themeRenderers).some((e) => e.includes("须配 [render] mount = \"app-theme\""))).toBe(true);
  });

  it("app-theme 挂载必须带 [theme] 段；theme 段独立成臂（至少一臂满足）", () => {
    const noTheme = {
      plugin: { id: "session.bad", name: "b" },
      kind: "session-composed",
      render: { component: "", mount: "app-theme" },
    } as unknown as SessionComposedManifest;
    expect(validateManifest(noTheme, themeRenderers).some((e) => e.includes("须声明 [theme] 段"))).toBe(true);
    // 仅 [theme] + [render]（无 pipeline）不再触发「至少一臂」——theme 计入。
    const onlyThemeArm = {
      plugin: { id: "session.only", name: "o" },
      kind: "session-composed",
      theme: { css: "@file:theme.css" },
      render: { component: "", mount: "app-theme" },
    } as unknown as SessionComposedManifest;
    expect(validateManifest(onlyThemeArm, themeRenderers).some((e) => e.includes("至少声明"))).toBe(false);
  });
});
