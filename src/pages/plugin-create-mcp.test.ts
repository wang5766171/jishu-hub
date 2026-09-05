// v0.9.0 需求1 二期 + 需求19：新建插件纯函数契约——MCP JSON 模式解析（包
// 裹/多条目/传输映射/校验）、表单三传输产出（buildManifest）、pluginType
// 三型（mcp/cli/agent）wire 映射与编辑派生（parseManifest）、name → id slug。

import { describe, expect, it } from "vitest";
import {
  buildManifest,
  mcpNameToId,
  parseManifest,
  parseMcpServerJson,
  serverToMcpSection,
  type FormState,
} from "./plugin-create-dialog";

/** 最小 tool 表单（其余字段取 emptyForm 等价值）。 */
function toolForm(partial: Partial<FormState>): FormState {
  return {
    id: "x",
    displayName: "X",
    icon: "",
    installHint: "",
    probeEnabled: false,
    probeCommand: "",
    versionArgs: "",
    versionRegex: "",
    transportKind: "cli",
    chatCommand: "",
    acpCommand: "",
    cwd: "",
    pipeStdin: false,
    abortBytes: "",
    configEnabled: false,
    configPath: "",
    configFormat: "json",
    sessionStore: "hub",
    abort: true,
    imageInput: false,
    streamText: false,
    pluginType: "mcp" as const,
    toolDescription: "",
    toolUsage: "",
    toolExample: "",
    toolNotes: "",
    mcpMode: "form",
    mcpTransport: "stdio",
    mcpCommand: "",
    mcpArgs: "",
    mcpEnv: "",
    mcpUrl: "",
    mcpHeaders: "",
    mcpJson: "",
    ...partial,
  };
}

describe("parseMcpServerJson（JSON 模式解析）", () => {
  it("参考图形态：直接 server 对象（缺省 type=stdio）", () => {
    const r = parseMcpServerJson(
      `{"my-mcp-server": {"type": "stdio", "command": "npx", "args": ["-y", "pkg"]}}`,
    );
    expect(r).toEqual({
      ok: true,
      name: "my-mcp-server",
      server: { type: "stdio", command: "npx", args: ["-y", "pkg"] },
    });
  });

  it("mcpServers 包裹与 streamable-http 映射", () => {
    const r = parseMcpServerJson(
      `{"mcpServers": {"remote": {"type": "streamable-http", "url": "https://x/mcp", "headers": {"Authorization": "Bearer t"}}}}`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.server.type).toBe("http");
      expect(r.server.url).toBe("https://x/mcp");
      expect(r.server.headers).toEqual({ Authorization: "Bearer t" });
    }
  });

  it("SSE 类型 + 环境变量", () => {
    const r = parseMcpServerJson(
      `{"s": {"type": "sse", "url": "http://h/sse"}}`,
    );
    expect(r.ok).toBe(true);
    const stdioEnv = parseMcpServerJson(
      `{"s": {"command": "npx", "env": {"K": "v", "BAD": 1}}}`,
    );
    expect(stdioEnv.ok).toBe(true);
    if (stdioEnv.ok) expect(stdioEnv.server.env).toEqual({ K: "v" }); // 非字符串值剔除
  });

  it("错误路径：非法 JSON / 多 server / 缺 command / 缺 url / 非法 url / 未知 type", () => {
    expect(!parseMcpServerJson("{oops").ok).toBe(true);
    const multi = parseMcpServerJson(`{"a": {"command": "x"}, "b": {"command": "y"}}`);
    expect(!multi.ok && multi.error.includes("仅支持声明一个")).toBe(true);
    const noCmd = parseMcpServerJson(`{"a": {"type": "stdio"}}`);
    expect(!noCmd.ok && noCmd.error.includes("command")).toBe(true);
    const noUrl = parseMcpServerJson(`{"a": {"type": "http"}}`);
    expect(!noUrl.ok && noUrl.error.includes("url")).toBe(true);
    const badUrl = parseMcpServerJson(`{"a": {"type": "http", "url": "ftp://x"}}`);
    expect(!badUrl.ok && badUrl.error.includes("http://")).toBe(true);
    const badType = parseMcpServerJson(`{"a": {"type": "ws"}}`);
    expect(!badType.ok && badType.error.includes("不支持的传输类型")).toBe(true);
    expect(!parseMcpServerJson(`{}`).ok).toBe(true);
  });
});

describe("buildManifest（表单三传输产出）", () => {
  it("stdio：command/args/env → [mcp] type=stdio", () => {
    const m = buildManifest(
      toolForm({
        mcpCommand: "npx",
        mcpArgs: "-y pkg",
        mcpEnv: "API_TOKEN=xxx\nBAD",
      }),
    ) as { mcp: Record<string, unknown> };
    expect(m.mcp).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "pkg"],
      env: { API_TOKEN: "xxx" }, // 无 = 的行忽略
    });
  });

  it("http：url + headers；sse：仅 url", () => {
    const http = buildManifest(
      toolForm({
        mcpTransport: "http",
        mcpUrl: "https://mcp.example.com/mcp",
        mcpHeaders: '{"Authorization": "Bearer your-token"}',
      }),
    ) as { mcp: Record<string, unknown> };
    expect(http.mcp).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer your-token" },
    });
    const sse = buildManifest(
      toolForm({ mcpTransport: "sse", mcpUrl: "https://h/sse" }),
    ) as { mcp: Record<string, unknown> };
    expect(sse.mcp).toEqual({ type: "sse", url: "https://h/sse" });
  });

  it("JSON 模式：产出与表单等价；非法输入抛错；空文本跳过 [mcp]", () => {
    const viaJson = buildManifest(
      toolForm({
        mcpMode: "json",
        mcpJson: `{"my": {"type": "http", "url": "https://x/m"}}`,
      }),
    ) as { mcp: Record<string, unknown> };
    expect(viaJson.mcp).toEqual({ type: "http", url: "https://x/m" });
    expect(() =>
      buildManifest(toolForm({ mcpMode: "json", mcpJson: `{"a": {"command": "x"}, "b": {}}` })),
    ).toThrow(/仅支持声明一个/);
    const none = buildManifest(toolForm({ mcpMode: "json", mcpJson: "" }));
    expect(none.mcp).toBeUndefined();
  });

  it("请求头非法：表单 http 模式抛错（提交拦截）", () => {
    expect(() =>
      buildManifest(
        toolForm({
          mcpTransport: "http",
          mcpUrl: "https://x",
          mcpHeaders: "not-json",
        }),
      ),
    ).toThrow(/JSON 对象/);
    expect(() =>
      buildManifest(
        toolForm({ mcpTransport: "http", mcpUrl: "https://x", mcpHeaders: '{"K": 1}' }),
      ),
    ).toThrow(/字符串/);
  });
});

describe("serverToMcpSection / mcpNameToId", () => {
  it("空集合省略字段", () => {
    expect(
      serverToMcpSection({ type: "stdio", command: "npx", args: [], env: {} }),
    ).toEqual({ type: "stdio", command: "npx" });
    expect(serverToMcpSection({ type: "sse", url: "https://h", headers: {} })).toEqual({
      type: "sse",
      url: "https://h",
    });
  });

  it("server 名 slug 化（JSON name 键预填 id）", () => {
    expect(mcpNameToId("My MCP Server")).toBe("my-mcp-server");
    expect(mcpNameToId("GitHub 仓库!工具")).toBe("github");
    expect(mcpNameToId("中文")).toBe("mcp-tool"); // 全非法字符回退
  });
});

describe("pluginType 三型 wire 映射与编辑派生（需求19）", () => {
  it("cli → kind=tool + [tool]，无 [mcp]", () => {
    const m = buildManifest(
      toolForm({
        pluginType: "cli",
        toolDescription: "GitHub 操作",
        toolUsage: "gh pr list",
        probeEnabled: true,
        probeCommand: "gh",
      }),
    ) as Record<string, unknown>;
    expect(m.kind).toBe("tool");
    expect(m.tool).toEqual({ description: "GitHub 操作", usage: "gh pr list" });
    expect(m.mcp).toBeUndefined();
    expect(m.probe).toEqual({ command: "gh" });
  });

  it("agent → 无 kind 字段 + transport/session/capabilities", () => {
    const m = buildManifest(
      toolForm({
        pluginType: "agent",
        transportKind: "cli",
        chatCommand: "gemini\n--prompt\n{prompt}",
      }),
    ) as Record<string, unknown>;
    expect(m.kind).toBeUndefined();
    expect((m.transport as Record<string, unknown>).kind).toBe("cli");
    expect(m.session).toEqual({ store: "hub" });
    expect(m.mcp).toBeUndefined();
    expect(m.tool).toBeUndefined();
  });

  it("mcp + 高级 [tool] 并存 → 两段齐备（编辑往返不丢段）", () => {
    const m = buildManifest(
      toolForm({
        pluginType: "mcp",
        mcpCommand: "npx",
        toolDescription: "文件系统",
        toolUsage: "MCP 工具",
      }),
    ) as Record<string, unknown>;
    expect(m.kind).toBe("tool");
    expect((m.mcp as Record<string, unknown>).command).toBe("npx");
    expect(m.tool).toEqual({ description: "文件系统", usage: "MCP 工具" });
  });

  it("parseManifest 派生 pluginType（agent / tool+mcp→mcp / tool→cli）", () => {
    const agent = parseManifest({
      schema: 1,
      info: { id: "a", display_name: "A" },
      transport: { kind: "cli", chat_command: ["a", "{prompt}"] },
    });
    expect(agent.form.pluginType).toBe("agent");

    const mcp = parseManifest({
      schema: 1,
      kind: "tool",
      info: { id: "m", display_name: "M" },
      mcp: { type: "http", url: "https://x/m" },
    });
    expect(mcp.form.pluginType).toBe("mcp");
    expect(mcp.form.mcpUrl).toBe("https://x/m");
    expect(mcp.form.mcpTransport).toBe("http");

    const cli = parseManifest({
      schema: 1,
      kind: "tool",
      info: { id: "c", display_name: "C" },
      tool: { description: "d", usage: "u" },
    });
    expect(cli.form.pluginType).toBe("cli");
    expect(cli.form.toolUsage).toBe("u");

    // tool + [tool] + [mcp] 并存的旧插件 → 派生 mcp（[tool] 值保留）
    const both = parseManifest({
      schema: 1,
      kind: "tool",
      info: { id: "b", display_name: "B" },
      tool: { description: "d", usage: "u" },
      mcp: { type: "stdio", command: "npx" },
    });
    expect(both.form.pluginType).toBe("mcp");
    expect(both.form.toolDescription).toBe("d");
  });
});

describe("MCP 表单极简化（需求19 GUI 裁决：ID 自动派生、无图标/安装提示）", () => {
  it("id 留空 → 由名称 slug 派生；icon/install_hint 空则不产出", () => {
    const m = buildManifest(
      toolForm({
        pluginType: "mcp",
        id: "",
        displayName: "My MCP Server",
        icon: "",
        installHint: "",
        mcpCommand: "npx",
      }),
    ) as { info: Record<string, unknown> };
    expect(m.info.id).toBe("my-mcp-server");
    expect(m.info.icon).toBeUndefined();
    expect(m.info.install_hint).toBeUndefined();
  });

  it("编辑回读（id 已有值）→ 用原 id，不覆盖", () => {
    const m = buildManifest(
      toolForm({
        pluginType: "mcp",
        id: "custom-id",
        displayName: "New Name",
        mcpUrl: "https://x/m",
        mcpTransport: "http",
      }),
    ) as { info: Record<string, unknown> };
    expect(m.info.id).toBe("custom-id");
  });

  it("cli 类型 id 留空不自动派生（id 是必填显示字段）", () => {
    const m = buildManifest(
      toolForm({
        pluginType: "cli",
        id: "",
        displayName: "X",
        toolDescription: "d",
        toolUsage: "u",
      }),
    ) as { info: Record<string, unknown> };
    expect(m.info.id).toBe("");
  });
});
