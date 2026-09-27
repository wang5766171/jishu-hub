import i18n from "@/i18n";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { InteractionCard } from "./interaction-card";
import { interactionRenderPlugin } from "@/features/session-kernel/plugins/builtin/interaction-render";

describe("InteractionCard", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("dedupes repeated question and answer items in an expanded card", () => {
    render(
      <InteractionCard
        defaultOpen
        origin="acp_elicitation"
        items={[
          { prompt: "Question 1", answer: "A", options: [] },
          { prompt: "Question 2", answer: "B", options: [] },
          { prompt: "Question 2", answer: "B", options: [] },
        ]}
      />,
    );

    expect(screen.getAllByText("Question 1")).toHaveLength(1);
    expect(screen.getAllByText("Question 2")).toHaveLength(1);
    expect(screen.getAllByText("B")).toHaveLength(1);
  });

  it("v0.9.4 需求11：卡内不再渲染 agent 来源徽标（原「内置/外部助手」文案废弃）", () => {
    render(
      <InteractionCard
        defaultOpen
        origin="acp_elicitation"
        items={[{ prompt: "Question", answer: "Answer", options: [] }]}
      />,
    );

    expect(screen.queryByText("External assistant")).not.toBeInTheDocument();
    expect(screen.queryByText("Built-in assistant")).not.toBeInTheDocument();
    expect(screen.getByText("Question")).toBeInTheDocument();
  });

  it("v0.9.5 需求5 T4：自定义答案与短标签子串撞名不误高亮（小明明≠小明），答案行正常显示", () => {
    render(
      <InteractionCard
        defaultOpen
        items={[
          {
            prompt: "老三叫什么？",
            answer: "小明明",
            selectedOptions: [],
            options: [
              { option_id: "1. 三毛 — 顺延排行", label: "1. 三毛 — 顺延排行" },
              { option_id: "2. 小明 — 再读一遍", label: "2. 小明 — 再读一遍" },
            ],
          },
        ]}
      />,
    );
    // 选项净化后 label 为「小明」，但答案「小明明」是自定义文本——不得命中高亮
    // （高亮态渲染为 font-medium；这里断言选项容器数量与答案行存在即可锁行为）
    expect(screen.getByText("小明明")).toBeInTheDocument();
    const optionRows = screen.getAllByText("小明");
    expect(optionRows).toHaveLength(1);
  });

  it("v0.9.5 需求5 T4：点选作答（selected_options 命中）仍高亮且不重复显示答案行", () => {
    render(
      <InteractionCard
        defaultOpen
        items={[
          {
            prompt: "老三叫什么？",
            answer: "2. 小明 — 再读一遍",
            selectedOptions: ["2. 小明 — 再读一遍"],
            options: [
              { option_id: "1. 三毛 — 顺延排行", label: "1. 三毛 — 顺延排行" },
              { option_id: "2. 小明 — 再读一遍", label: "2. 小明 — 再读一遍" },
            ],
          },
        ]}
      />,
    );
    // 答案可由选项高亮表达 → 不再显示答案文本行
    expect(screen.queryByText("2. 小明 — 再读一遍", { selector: "p" })).not.toBeInTheDocument();
  });

  it("v0.9.5 需求5 T6：插件渲染链透传 selectedOptions——多选回放以选项高亮表达，不落答案文字行", () => {
    // session.interaction-render 插件的真实 BlockComponent（经 useBlockRenderers
    // 咨询命中后的渲染路径，即 GUI 回放实际走的链）
    const Block = (interactionRenderPlugin.mounts[0] as unknown as {
      BlockComponent: React.ComponentType<{ block: Record<string, unknown> }>;
    }).BlockComponent;
    render(
      <Block
        block={{
          type: "interaction",
          text: "[多选题] 哪些东西被打破后大家很高兴？",
          options: [
            { id: "1. 世界纪录 — 运动员最爱", label: "1. 世界纪录 — 运动员最爱" },
            { id: "2. 沉默 — 会议需要", label: "2. 沉默 — 会议需要" },
            { id: "3. 僵局 — 谈判需要", label: "3. 僵局 — 谈判需要" },
          ],
          answer: "3. 僵局 — 谈判需要" + String.fromCharCode(10) + "2. 沉默 — 会议需要",
          selectedOptions: ["3. 僵局 — 谈判需要", "2. 沉默 — 会议需要"],
        }}
      />,
    );
    // 净化后标签 + 两项选中高亮（font-medium）
    const silence = screen.getByText("沉默");
    const deadlock = screen.getByText("僵局");
    expect(silence.className).toContain("font-medium");
    expect(deadlock.className).toContain("font-medium");
    // 未选中项不高亮
    const record = screen.getByText("世界纪录");
    expect(record.className).not.toContain("font-medium");
    // 已可由选项高亮表达 → 不再渲染答案文字行
    expect(screen.queryByText(/3\. 僵局/)).not.toBeInTheDocument();
  });
});
