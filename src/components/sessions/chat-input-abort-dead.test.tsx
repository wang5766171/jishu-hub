// v0.9.8 需求19-D：abort_chat 返回 process_found——引擎已死时停止立即本地收口
// （不等永不到来的 turn_complete(Aborted) 回执），修复「僵尸处理中 + 停止无效」。
import i18n from "@/i18n";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { streamStore } from "@/hooks/use-stream-store";
import { ChatInput } from "./chat-input";

const invokeCommand = vi.hoisted(() => vi.fn());
const devLogSpy = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));
vi.mock("@/lib/dev-log", () => ({
  devLog: devLogSpy,
}));
vi.mock("@/hooks/use-stream-store", async (importOriginal) => {
  // 真单例（测 drop 副作用）——仅此 mock 占位以保持模块图稳定。
  return await importOriginal<typeof import("@/hooks/use-stream-store")>();
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

beforeEach(() => {
  invokeCommand.mockReset();
  invokeCommand.mockImplementation((cmd: string) => {
    if (cmd === "abort_chat") return Promise.resolve({ process_found: !DEAD });
    if (cmd === "session_tool_list") return Promise.resolve([]);
    if (cmd === "equip_config_get")
      return Promise.resolve({ enabled: true, session_card: true, session_limit: 1, input_bar: true, market_zone: true, third_party: true });
    if (cmd === "equipment_tags_list") return Promise.resolve([]);
    if (cmd === "task_profile_latest") return Promise.resolve(null);
    if (cmd === "plugin_list") return Promise.resolve({ plugins: [] });
    if (cmd === "skillhub_installed") return Promise.resolve({});
    if (cmd === "pi_package_installed_sources") return Promise.resolve([]);
    if (cmd === "get_scene_suggest_dismissed") return Promise.resolve(false);
    if (cmd === "workspace_scene") return Promise.resolve(null);
    return Promise.resolve({});
  });
});

let DEAD = false;

function mount(onAbort: () => Promise<void> | void) {
  return render(
    <ChatInput
      sessionId="dead-proc-session"
      projectPath="D:\\p"
      agentId="jishu-self"
      slashCommands={[]}
      onAbort={onAbort}
    />,
  );
}

async function clickStop() {
  const stopBtn = await waitFor(() => {
    const b = [...document.querySelectorAll("button")].find(
      (x) => (x.title || "") === "停止" && !(x as HTMLButtonElement).disabled,
    );
    if (!b) throw new Error("stop button not present");
    return b as HTMLButtonElement;
  });
    fireEvent.click(stopBtn);
}

describe("ChatInput 停止（需求19-D：死进程本地收口）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh");
    DEAD = false;
    streamStore.drop("dead-proc-session");
  });

  it("U-DA1: process_found=false（引擎已死）——onAbort 提交后直接 drop 流收口", async () => {
    DEAD = true;
    const onAbort = vi.fn().mockResolvedValue(undefined);
    mount(onAbort);
    // 制造流式态：流挂在会话键（等交互/回合运行中的现场等价）。
    streamStore.start("dead-proc-session", "等回答的挂起消息");
    await clickStop();
    await waitFor(() => {
      expect(onAbort).toHaveBeenCalled();
    });
    await waitFor(() => {
      // 停止救回：流被 drop（「处理中」状态源消失）。
      expect(streamStore.getState("dead-proc-session")).toBeNull();
    });
  });

  it("U-DA2: process_found=true（进程活着）——不抢先 drop（等 turn_complete 收口的既有语义不变）", async () => {
    const onAbort = vi.fn().mockResolvedValue(undefined);
    mount(onAbort);
    streamStore.start("dead-proc-session", "运行中消息");
    await clickStop();
    await waitFor(() => {
      expect(onAbort).toHaveBeenCalled();
    });
    // 回执将至：流保留（收口归属 turn_complete 处理）。
    expect(streamStore.getState("dead-proc-session")).not.toBeNull();
    streamStore.drop("dead-proc-session");
  });
});
