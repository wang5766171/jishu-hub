/**
 * v0.9.8 评审修复轮 R2（S 域，S-16）：命令行修改插件状态后的同步卡。
 * 对应 tests/S-用例清单 S16-U1。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliPluginChangeCard } from "./hybrid-install-confirmation";

const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/features/session-kernel/shell/panel-activation", () => ({ requestPanelActivation: vi.fn() }));
vi.mock("@/features/session-kernel/shell/install-spotlight", () => ({ requestInstallSpotlight: vi.fn() }));
vi.mock("@/lib/app-nav", () => ({ openManagePage: vi.fn() }));

const CHANGE = { id: "session.demo", action: "enable" };

describe("评审修复轮 R2：命令行变更卡同步失败有反馈", () => {
  let unhandled = 0;
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled += 1;
    event.preventDefault();
  };

  beforeEach(() => {
    unhandled = 0;
    window.addEventListener("unhandledrejection", onUnhandled);
    invokeCommand.mockReset();
  });

  afterEach(() => {
    window.removeEventListener("unhandledrejection", onUnhandled);
  });

  it("S16-U1 同步失败：卡上显示失败、变更清单还在、按钮可再点、没有未处理的拒绝", async () => {
    invokeCommand.mockImplementation((command: string) =>
      command === "cli_plugin_changed_poll"
        ? Promise.resolve({ changes: [CHANGE] })
        : Promise.reject(new Error("reload boom")));

    render(<CliPluginChangeCard />);
    const syncButton = await screen.findByRole("button", { name: "cliChange.sync" });
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(syncButton);

    expect(await screen.findByRole("alert")).toHaveTextContent("cliChange.syncFailed");
    // 变更清单没有因失败被清掉；按钮从「同步中」恢复为可点
    expect(screen.getByText(CHANGE.id)).toBeInTheDocument();
    await waitFor(() => expect(syncButton).not.toBeDisabled());
    expect(invokeCommand).toHaveBeenCalledWith("plugin_reload");
    expect(unhandled).toBe(0);
  });

  it("同步成功：卡关闭（对照组）", async () => {
    invokeCommand.mockImplementation((command: string) =>
      command === "cli_plugin_changed_poll"
        ? Promise.resolve({ changes: [CHANGE] })
        : Promise.resolve(null));

    render(<CliPluginChangeCard />);
    fireEvent.click(await screen.findByRole("button", { name: "cliChange.sync" }));

    await waitFor(() => expect(screen.queryByText(CHANGE.id)).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(unhandled).toBe(0);
  });
});
