// v0.9.0 需求1 二期：新建插件 MCP 区纯函数契约——JSON 模式解析（包裹/
// 多条目/传输映射/校验）、表单三传输产出（buildManifest）、name → id slug。
// 参考图：mcp-stdio-json.png 的 `{"server-name": {...}}` 形态。

import { describe, expect, it } from "vitest";
import {
  buildManifest,
  mcpNameToId,
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
    kind: "tool",
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
