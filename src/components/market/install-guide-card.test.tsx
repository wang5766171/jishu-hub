import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { InstallGuideCard, type InstallGuideInfo } from "./install-guide-card";

/** v0.9.8 需求4：装后引导卡（三源统一形态）——技能/精选/扩展三形态与
 * 配置/GUI 适配/关闭三动作。 */
describe("InstallGuideCard（需求4 装后引导卡）", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  const skillInfo: InstallGuideInfo = {
    title: "深度研究技能",
    kind: "skill",
    description: "多轮检索并汇总成报告。适合长任务研究",
    requiresApiKey: true,
    usageHint: "多轮检索并汇总成报告",
  };

  it("U1: 技能源——徽标+说明+首次使用+配置钮（requires_api_key）", () => {
    const onNavigateConfig = vi.fn();
    render(
      <InstallGuideCard info={skillInfo} onNavigateConfig={onNavigateConfig} onClose={() => {}} />,
    );
    expect(screen.getByText("深度研究技能")).toBeTruthy();
    expect(screen.getByText("技能")).toBeTruthy();
    // 描述与示例首句同文（技能示例=描述首句改造，设计使然）——多处命中合法
    expect(screen.getAllByText(/多轮检索并汇总成报告/).length).toBeGreaterThan(0);
    expect(screen.getByText(/首次使用/)).toBeTruthy();
    expect(screen.getByText(/需要配置：API Key/)).toBeTruthy();
    // 技能源无 GUI 适配
    expect(screen.queryByText(/GUI 适配/)).toBeNull();
  });

  it("U1: 精选源（curated usage_hint）——徽标按 kind+示例；无配置钮", () => {
    render(
      <InstallGuideCard
        info={{ title: "流程规划", kind: "plugin", description: "多步骤任务先拆成执行计划", usageHint: "把这件事拆成有依赖关系的执行计划再动手" }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("插件")).toBeTruthy();
    expect(screen.getByText(/把这件事拆成/)).toBeTruthy();
    expect(screen.queryByText(/需要配置/)).toBeNull();
  });

  it("U1: 扩展源——GUI 适配按钮在位", () => {
    render(
      <InstallGuideCard
        info={{ title: "some-extension", kind: "extension", description: "pi 扩展", packageName: "npm:some-extension@1.0.0", guiAdaptable: true }}
        onGuiAdapt={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("扩展")).toBeTruthy();
    expect(screen.getByText(/GUI 适配/)).toBeTruthy();
  });

  it("U2: 三动作回调——配置/GUI 适配/关闭", async () => {
    const onNavigateConfig = vi.fn();
    const onGuiAdapt = vi.fn();
    const onClose = vi.fn();
    render(
      <InstallGuideCard
        info={{ ...skillInfo, guiAdaptable: true, packageName: "npm:x@1" }}
        onNavigateConfig={onNavigateConfig}
        onGuiAdapt={onGuiAdapt}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText(/需要配置：API Key/));
    expect(onNavigateConfig).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText(/GUI 适配/));
    expect(onGuiAdapt).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle("关闭"));
    // 关闭经 280ms 退出动画后回调 onClose
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 1500 });
  });
});
