/** v0.9.1 需求6：PowerShell 工具配置页开关测试。
 *
 * 覆盖三点：
 * 1. toolCatalogFor 纯函数——powershell 仅进 Windows 目录，且排在末位；
 * 2. 组件渲染——Windows UA 出现 PowerShell 勾选项，非 Windows UA 不出现；
 * 3. 勾选保存——payload 的 defaultTools 含 powershell（未配置时从 pi 回退
 *    四件套起勾）；只读预设固定白名单不含 powershell。
 *
 * 模块级 PI_TOOL_CATALOG 在 import 时求值，Windows 用例须先改写
 * navigator.userAgent 再 vi.resetModules + 动态 import。 */
import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { toolCatalogFor } from "./jishu-agent-settings";

vi.mock("@/agents", () => ({
  useAgent: () => ({
    manageAgentId: "jishu",
    manageAgent: { thinking_levels: ["off", "low", "high"] },
  }),
}));

const invokeCommandMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand: (...args: unknown[]) => invokeCommandMock(...args),
}));

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const JSDOM_UA = window.navigator.userAgent;

function setUserAgent(value: string) {
  Object.defineProperty(window.navigator, "userAgent", { value, configurable: true });
}

async function renderBlock(agentConfig: Record<string, unknown> | null) {
  const { JishuAgentSettingsBlock } = await import("./jishu-agent-settings");
  render(
    <JishuAgentSettingsBlock
      agentConfig={agentConfig}
      onSaved={() => {}}
      onSaveStateChange={() => {}}
      registerSave={() => {}}
    />,
  );
}

describe("toolCatalogFor", () => {
  it("adds powershell to the Windows catalog only, after the built-in set", () => {
    const win = toolCatalogFor(true);
    const other = toolCatalogFor(false);
    expect(win).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);
    expect(other).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  });
});

describe("JishuAgentSettingsBlock powershell 开关", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });
  beforeEach(() => {
    invokeCommandMock.mockClear();
    setUserAgent(JSDOM_UA);
    vi.resetModules();
  });

  it("shows the PowerShell checkbox on Windows", async () => {
    setUserAgent(WINDOWS_UA);
    await renderBlock({ defaultTools: null });
    expect(screen.getByLabelText("PowerShell")).toBeTruthy();
  });

  it("hides the PowerShell checkbox off Windows (pi throws there)", async () => {
    await renderBlock({ defaultTools: null });
    expect(screen.queryByLabelText("PowerShell")).toBeNull();
    expect(screen.getByLabelText("Bash")).toBeTruthy();
  });

  it("unset defaults to the all-tools preset; custom preset saves the checked subset", async () => {
    setUserAgent(WINDOWS_UA);
    const registered: Array<() => void> = [];
    const { JishuAgentSettingsBlock } = await import("./jishu-agent-settings");
    render(
      <JishuAgentSettingsBlock
        agentConfig={{ defaultTools: null }}
        onSaved={() => {}}
        onSaveStateChange={() => {}}
        registerSave={(fn) => registered.push(fn)}
      />,
    );
    // v0.9.1 需求13：未配置 → 预设=全部工具集，全部勾选（含 PowerShell）
    // 且固定不可编辑。
    const presetSelect = document.getElementById("jishu-tool-preset") as HTMLSelectElement;
    expect(presetSelect.value).toBe("all");
    const powershell = screen.getByLabelText("PowerShell") as HTMLInputElement;
    expect(powershell.checked).toBe(true);
    expect(powershell.disabled).toBe(true);

    // 切自定义预设 → 取消 write → 保存载荷为目录序全集去 write（含 powershell）。
    fireEvent.change(presetSelect, { target: { value: "custom" } });
    fireEvent.click(screen.getByLabelText("Write"));
    expect(registered.length).toBeGreaterThan(0);
    await registered[registered.length - 1]!();
    expect(invokeCommandMock).toHaveBeenCalledWith(
      "save_config",
      expect.objectContaining({
        agentId: "jishu",
        config: expect.objectContaining({
          defaultTools: ["read", "bash", "edit", "grep", "find", "ls", "powershell"],
        }),
      }),
    );
  });

  it("readonly preset whitelist excludes powershell", async () => {
    setUserAgent(WINDOWS_UA);
    const { JishuAgentSettingsBlock } = await import("./jishu-agent-settings");
    render(
      <JishuAgentSettingsBlock
        agentConfig={{ defaultTools: ["read", "grep", "find", "ls"] }}
        onSaved={() => {}}
        onSaveStateChange={() => {}}
        registerSave={() => {}}
      />,
    );
    // 只读预设勾选固定不可编辑，powershell 处于未勾选
    const powershell = screen.getByLabelText("PowerShell") as HTMLInputElement;
    expect(powershell.checked).toBe(false);
    expect(powershell.disabled).toBe(true);
    expect((screen.getByLabelText("Read") as HTMLInputElement).checked).toBe(true);
  });
});
