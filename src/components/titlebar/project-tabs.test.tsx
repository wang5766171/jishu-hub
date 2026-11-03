/**
 * v0.9.6 需求4 + 补充②：标题栏项目标签组件测试。
 * 覆盖：空态不渲染 / 当前项目标签（名+关闭钮）/ 固定标签渲染与灯色 /
 * 点击切换回调（最近会话+agentId）/ 解除固定不冒泡 / 已删项目过滤。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Project } from "@/types";
import type { ProjectTabsState, TabLight } from "./use-project-tabs";

import { ProjectTabs } from "./project-tabs";

const proj = (name: string, encoded: string): Project => ({
  name,
  path: `D:/${name}`,
  encoded_name: encoded,
  session_count: 1,
  last_active: null,
  agent_ids: ["jishu-self"],
  initialized: true,
  has_claude_md: false,
});

const PROJECT_A = proj("jishu-hub", "enc-a");
const PROJECT_B = proj("other-work", "enc-b");

function makeTabs(over: Partial<ProjectTabsState> = {}): ProjectTabsState {
  return {
    pins: [],
    lights: {},
    lastSession: {},
    pinProject: vi.fn(),
    unpinProject: vi.fn(),
    reorderPins: vi.fn(),
    noteLeave: vi.fn(),
    clearLight: vi.fn(),
    ...over,
  };
}

describe("v0.9.6 需求4（含补充②）：ProjectTabs", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("空态：无当前项目且无固定 → 整条不渲染", () => {
    const { container } = render(
      <ProjectTabs currentProject={null} projects={[PROJECT_A]} tabs={makeTabs()} onSwitchToProject={vi.fn()} onCloseCurrentProject={vi.fn()} />,
    );
    expect(screen.queryByText("jishu-hub")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("当前项目标签：显示项目名 + 关闭按钮；无固定时不渲染其他标签", () => {
    render(
      <ProjectTabs currentProject={PROJECT_A} projects={[PROJECT_A]} tabs={makeTabs()} onSwitchToProject={vi.fn()} onCloseCurrentProject={vi.fn()} />,
    );
    expect(screen.getByText("jishu-hub")).toBeTruthy();
    expect(screen.getByTitle("关闭当前项目")).toBeTruthy();
    expect(screen.queryByText("other-work")).toBeNull();
  });

  it("固定标签：渲染项目名；点击带最近会话+agentId 回调并清灯", () => {
    const onSwitch = vi.fn();
    const tabs = makeTabs({
      pins: ["enc-b"],
      lastSession: { "enc-b": { sessionId: "s-b", agentId: "codex" } },
    });
    render(
      <ProjectTabs currentProject={PROJECT_A} projects={[PROJECT_A, PROJECT_B]} tabs={tabs} onSwitchToProject={onSwitch} onCloseCurrentProject={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("other-work"));
    expect(onSwitch).toHaveBeenCalledWith(PROJECT_B, "s-b", "codex");
    // 补充⑤：点击不清灯（灯常驻随状态流转）
    expect(tabs.clearLight).not.toHaveBeenCalled();
  });

  it("灯色 class：running 蓝 / done 绿 / failed 红映射正确", () => {
    const cases: [TabLight, string][] = [
      ["running", "bg-blue-500"],
      ["done", "bg-emerald-500"],
      ["failed", "bg-red-500"],
    ];
    for (const [light, cls] of cases) {
      cleanup();
      render(
        <ProjectTabs
          currentProject={PROJECT_A}
          projects={[PROJECT_A, PROJECT_B]}
          tabs={makeTabs({ pins: ["enc-b"], lights: { "enc-b": light } })}
          onSwitchToProject={vi.fn()}
          onCloseCurrentProject={vi.fn()}
        />,
      );
      const dot = document.querySelector(`span.rounded-full.${cls.split(" ")[0]}`);
      expect(dot, `${light} → ${cls}`).not.toBeNull();
      expect(dot?.className).toContain(cls);
    }
  });

  it("补充⑤灯常驻：空闲固定标签显示灰点（无灯不消失）", () => {
    render(
      <ProjectTabs currentProject={PROJECT_A} projects={[PROJECT_A, PROJECT_B]} tabs={makeTabs({ pins: ["enc-b"] })} onSwitchToProject={vi.fn()} onCloseCurrentProject={vi.fn()} />,
    );
    expect(document.querySelector("span[class*='bg-muted-foreground']")).not.toBeNull();
  });

  it("关闭标签（=取消固定）：按钮点击触发 unpinProject 且不触发切换", () => {
    const onSwitch = vi.fn();
    const tabs = makeTabs({ pins: ["enc-b"] });
    render(
      <ProjectTabs currentProject={PROJECT_A} projects={[PROJECT_A, PROJECT_B]} tabs={tabs} onSwitchToProject={onSwitch} onCloseCurrentProject={vi.fn()} />,
    );
    fireEvent.click(screen.getByTitle("关闭标签"));
    expect(tabs.unpinProject).toHaveBeenCalledWith("enc-b");
    expect(onSwitch).not.toHaveBeenCalled();
  });


  it("补充③顺序：当前项目未固定时排末尾（不强制首位）；固定后按 pins 序渲染", () => {
    // B、C 已固定，当前项目 A 未固定 → 顺序 [B, C, A]
    const { unmount } = render(
      <ProjectTabs
        currentProject={PROJECT_A}
        projects={[PROJECT_A, PROJECT_B, proj("third", "enc-c")]}
        tabs={makeTabs({ pins: ["enc-b", "enc-c"] })}
        onSwitchToProject={vi.fn()}
        onCloseCurrentProject={vi.fn()}
      />,
    );
    const names = screen.queryAllByText(/other-work|third|jishu-hub/).map(e => e.textContent);
    expect(names.indexOf("other-work")).toBeLessThan(names.indexOf("third"));
    expect(names.indexOf("third")).toBeLessThan(names.indexOf("jishu-hub"));
    unmount();
    // 当前项目在 pins 中 → 按 pins 序（A 在首位则首位，带关闭钮）
    render(
      <ProjectTabs
        currentProject={PROJECT_A}
        projects={[PROJECT_A, PROJECT_B]}
        tabs={makeTabs({ pins: ["enc-a", "enc-b"] })}
        onSwitchToProject={vi.fn()}
        onCloseCurrentProject={vi.fn()}
      />,
    );
    const names2 = screen.queryAllByText(/other-work|jishu-hub/).map(e => e.textContent);
    expect(names2.indexOf("jishu-hub")).toBeLessThan(names2.indexOf("other-work"));
    expect(screen.getByTitle("关闭当前项目")).toBeTruthy();
  });

  it("补充③拖拽：dragStart→drop 触发 reorderPins", () => {
    const tabs = makeTabs({ pins: ["enc-b", "enc-gone"] });
    const PROJECT_C = proj("third", "enc-c");
    render(
      <ProjectTabs currentProject={PROJECT_A} projects={[PROJECT_A, PROJECT_B, PROJECT_C]} tabs={{ ...tabs, pins: ["enc-b", "enc-c"] }} onSwitchToProject={vi.fn()} onCloseCurrentProject={vi.fn()} />,
    );
    const src = screen.getByText("other-work").closest("[draggable]");
    const dst = screen.getByText("third").closest("[draggable]");
    fireEvent.dragStart(src!);
    fireEvent.dragOver(dst!, { preventDefault: () => {} });
    fireEvent.drop(dst!, { preventDefault: () => {} });
    expect(tabs.reorderPins).toHaveBeenCalledWith("enc-b", "enc-c");
  });

  it("pins 中已删除项目（projects 查无）不渲染；当前项目不重复为固定标签", () => {
    render(
      <ProjectTabs
        currentProject={PROJECT_A}
        projects={[PROJECT_A]}
        tabs={makeTabs({ pins: ["enc-a", "enc-gone"] })}
        onSwitchToProject={vi.fn()}
        onCloseCurrentProject={vi.fn()}
      />,
    );
    expect(screen.queryAllByText("jishu-hub").length).toBe(1); // 仅当前 tab
  });
});
