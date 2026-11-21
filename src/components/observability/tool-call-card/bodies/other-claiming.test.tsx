// 需求4 Q1 定证（R3）：不 mock matchToolResultRenderer——验证真实适配组件
// 经 composed plugin 装载链被 OtherBody 认领消费。这比 anchor test 更进一步：
// anchor test mock 了匹配函数；本测试走真实 composedPlugins → buildComposedDescriptor
// → tool-result-renderer mount → matchToolResultRenderer 全链。
import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";

// 不 mock use-block-renderers——用真实实现（composedPlugins 需要 invoke mock）
vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === "composed_plugin_manifests") {
      return Promise.resolve([
        {
          id: "session.test-claim",
          manifest: {
            plugin: { id: "session.test-claim", name: "测试认领", description: "测试", kind: "session-composed" },
            source: { type: "tool-result", tool_name: "my_test_tool" },
            render: { component: "@file:component.js", mount: "tool-output" },
            _dir: "/tmp/test-plugin",
            _files: { "component.js": "abc123", "plugin.toml": "def456" },
          },
        },
      ]);
    }
    if (cmd === "plugin_list") {
      return Promise.resolve({
        plugins: [{ id: "session.test-claim", kind: "session", enabled: true }],
        manifest_errors: [],
      });
    }
    return Promise.resolve([]);
  }),
  useInvoke: vi.fn(() => ({ data: null, loading: false, error: null, refetch: () => {} })),
}));

// mock hybrid-runtime 的 loadHybridComponent——返回一个简单组件（真实的
// JS 文件装载在浏览器环境才能跑；此处验证的是「装载到 mount 注册」链）
vi.mock("@/features/session-kernel/capabilities/composition/hybrid-runtime", () => ({
  loadHybridComponent: vi.fn().mockResolvedValue(function TestClaimComponent(props: Record<string, unknown>) {
    const payload = props.payload as { toolName?: string; output?: string; details?: Record<string, unknown> } | undefined;
    return <div data-testid="claimed-render">{String(payload?.toolName)} | {String(payload?.details?.title ?? "no-title")} | {String(payload?.output ?? "").slice(0, 20)}</div>;
  }),
  setHybridErrorHandler: vi.fn(),
}));

import { OtherBody } from "./OtherBody";
import { matchToolResultRenderer } from "@/features/session-kernel/plugins/mounts/use-block-renderers";
import { reloadComposed } from "@/features/session-kernel/capabilities/composition/loader";

describe("需求4 Q1 定证：tool-output 适配件真实认领链（不 mock 匹配函数）", () => {
  beforeAll(async () => {
    // 触发组合件装载（从 composed_plugin_manifests 拉取 → 解析 @file: 组件 →
    // buildComposedDescriptor → tool-result-renderer mount 注册）
    await reloadComposed();
  });

  it("matchToolResultRenderer 真实返回认领组件", () => {
    const match = matchToolResultRenderer("my_test_tool");
    expect(match).not.toBeNull();
    expect(match?.component).toBeDefined();
  });

  it("OtherBody 用真实认领组件渲染 tool result（替换默认渲染）", () => {
    render(
      <OtherBody
        input={{ url: "https://test.example.com" }}
        output="这是工具输出的正文内容"
        details={{ title: "测试页面标题", wordCount: 100 }}
        kind="other"
        toolName="my_test_tool"
      />,
    );

    // 认领组件渲染了（而非默认的 pre+details）
    const claimed = screen.getByTestId("claimed-render");
    expect(claimed).toBeTruthy();
    expect(claimed.textContent).toContain("my_test_tool");
    expect(claimed.textContent).toContain("测试页面标题");
    expect(claimed.textContent).toContain("这是工具输出的正文内容");
  });

  it("无认领时仍走默认渲染（负对照）", () => {
    render(
      <OtherBody
        input={{ query: "test" }}
        output="普通工具输出"
        kind="other"
        toolName="unknown_tool_no_claim"
      />,
    );
    // 默认渲染：无 claimed-render 标记
    expect(screen.queryByTestId("claimed-render")).toBeNull();
  });
});
