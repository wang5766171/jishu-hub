/**
 * v0.9.8 需求22（评审修复轮 R2）：session-context 给**每个**会话注入产物引用
 * 格式（项目相对路径 + 正斜杠）。此前这条规则由任务执行器扩展注入，而执行器
 * 对所有会话常驻；收口「任务纪律只注入任务会话」之后，这条通用规则改由
 * 本扩展提供——普通会话仍拿得到，成果链接照常能打开（NA-G11）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import sessionContextExtension from "./session-context";

type Handler = (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string } | void>;

async function systemPromptFor(sessionId = "sid-1") {
  const handlers = new Map<string, Handler>();
  sessionContextExtension({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as never);
  const handler = handlers.get("before_agent_start") as Handler;
  const result = await handler(
    { systemPrompt: "BASE" },
    { sessionManager: { getSessionId: () => sessionId } },
  );
  return result?.systemPrompt ?? "";
}

const saved = {
  hubHome: process.env.JISHU_HUB_HOME,
  projectPath: process.env.JISHU_PROJECT_PATH,
};

describe("session-context 引用格式给每个会话", () => {
  afterEach(() => {
    for (const [key, value] of [
      ["JISHU_HUB_HOME", saved.hubHome],
      ["JISHU_PROJECT_PATH", saved.projectPath],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("真实项目的普通会话：拿到引用格式（相对路径 + 正斜杠），不注入默认空间指引", async () => {
    process.env.JISHU_HUB_HOME = join(tmpRoot(), "hubhome");
    process.env.JISHU_PROJECT_PATH = join(tmpRoot(), "work", "app");
    const systemPrompt = await systemPromptFor();
    expect(systemPrompt).toContain("session_id: sid-1");
    expect(systemPrompt).toContain("【引用格式】");
    expect(systemPrompt).toContain("jishu-artifact://");
    expect(systemPrompt).toContain("禁止绝对路径、禁止反斜杠");
    expect(systemPrompt).not.toContain("session_workspace");
  });

  it("默认空间的会话：沿用带会话前缀的那段指引，不重复注入通用规则", async () => {
    const hubHome = join(tmpRoot(), "hubhome");
    process.env.JISHU_HUB_HOME = hubHome;
    process.env.JISHU_PROJECT_PATH = join(hubHome, "JishuProjects");
    const systemPrompt = await systemPromptFor("sid-default");
    expect(systemPrompt).toContain("session_workspace:");
    expect(systemPrompt).toContain("引用链接注意");
    expect(systemPrompt).toContain(`jishu-artifact://sessions/sid-default/`);
    expect(systemPrompt).not.toContain("【引用格式】");
  });

  it("没有项目环境变量（编排器 / 子会话）：同样拿到引用格式", async () => {
    delete process.env.JISHU_HUB_HOME;
    delete process.env.JISHU_PROJECT_PATH;
    const systemPrompt = await systemPromptFor("sid-sub");
    expect(systemPrompt).toContain("【引用格式】");
    expect(systemPrompt).toContain("session_id: sid-sub");
  });
});

function tmpRoot() {
  return process.platform === "win32" ? "C:\\tmp\\jishu-ctx-test" : "/tmp/jishu-ctx-test";
}
