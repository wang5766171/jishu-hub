import i18n from "@/i18n";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PluginMarketPanel } from "./plugin-market";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirmDialog: () => ({
    confirm: async () => true,
    alert: async () => {},
    dialogNode: null,
  }),
}));

/** v0.9.8 需求9-③：busyIds 集合化——两项安装并行各自 spinner，单项完成
 * 只清自己（原 busyId 单值互斥静默丢弃第二个点击，用户实测 #4）。 */
describe("插件市场并发安装（需求9-③）", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(() => {
    invokeCommand.mockReset();
    invokeCommand.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      switch (cmd) {
        case "plugin_list":
          return Promise.resolve({ plugins: [] });
        case "market_list_curated":
          return Promise.resolve([
            { id: "plugin-a", kind: "agent", title: "并发件甲", description: "d", category: "c", scenes: [], required: false },
            { id: "plugin-b", kind: "agent", title: "并发件乙", description: "d", category: "c", scenes: [], required: false },
          ]);
        case "pi_package_catalog":
        case "pi_package_installed_sources":
        case "piindex_search":
          return Promise.resolve([]);
        case "skillhub_list":
          return Promise.resolve({ skills: [], total: 0 });
        case "skillhub_installed":
          return Promise.resolve({});
        case "market_install":
          // 挂起直到测试手动 resolve——锁住 busy 态供并行断言（数组槽：
          // 每次调用各占一格，支持逐项放行）
          return new Promise((resolve) => {
            const slots = ((globalThis as Record<string, unknown>).__resolveInstalls ??= []) as Array<(v: string) => void>;
            slots.push(resolve);
          });
        default:
          return Promise.resolve({ cmd, args });
      }
    });
  });

  it("U3a: 两项并发安装各自 spinner，单项完成只清自己", async () => {
    render(<PluginMarketPanel onChanged={() => {}} />);

    // 等精选两卡渲染出来，容器内找各自安装钮（按钮名不含卡片标题）
    await screen.findByText("并发件甲");
    const findInstallBtn = (title: string) => {
      // 取「最深」匹配容器（祖先容器也含标题文本——首个命中是列表级祖先，
      // 会错拿别卡的按钮）
      const candidates = [...document.querySelectorAll("div")]
        .filter((d) => d.textContent?.includes(title) && d.querySelector("button") !== null);
      const card = candidates[candidates.length - 1];
      const btn = [...(card?.querySelectorAll("button") ?? [])].find((b) =>
        b.textContent?.includes("安装"),
      );
      if (!btn) throw new Error(`install button not found for ${title}`);
      return btn as HTMLButtonElement;
    };
    const btnA = findInstallBtn("并发件甲");
    const btnB = findInstallBtn("并发件乙");

    // 连续点两项安装（原实现第二点被 busyId 单值互斥静默丢弃）
    fireEvent.click(btnA);
    fireEvent.click(btnB);

    // 两按钮同时进入 busy（disabled + spinner 存在性以 disabled 判定）
    await waitFor(() => {
      expect(btnA).toBeDisabled();
      expect(btnB).toBeDisabled();
    });

    // 完成甲（第一个挂起调用）：busy 只清甲，乙仍 busy（load() 会重渲染换
    // 节点——断言用实时重查，避免陈旧引用）
    const slots = (globalThis as Record<string, unknown>).__resolveInstalls as Array<(v: string) => void>;
    expect(slots.length).toBe(2);
    slots[0]("installed");
    await waitFor(() => {
      expect(findInstallBtn("并发件甲")).not.toBeDisabled();
    });
    expect(findInstallBtn("并发件乙")).toBeDisabled();
  });
});
