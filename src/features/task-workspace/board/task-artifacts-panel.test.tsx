// v0.9.8 需求10 D10-2：任务产物区——列表渲染（名称/大小）+打开接线+空态降级。
import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskArtifactsPanel } from "./task-artifacts-panel";

const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));

const FILES = [
  { name: "report.md", rel_path: "report.md", abs_path: "D:\\p\\.jishu-hub\\tasks\\t1\\artifacts\\report.md", size: 4096, modified_ms: 1 },
  { name: "data.json", rel_path: "sub/data.json", abs_path: "D:\\p\\.jishu-hub\\tasks\\t1\\artifacts\\sub\\data.json", size: 2, modified_ms: 2 },
];

describe("TaskArtifactsPanel（需求10 成果卡 L1）", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });
  beforeEach(() => {
    invokeCommand.mockReset();
    invokeCommand.mockImplementation((cmd: string) => {
      if (cmd === "task_artifacts_list") return Promise.resolve(FILES);
      return Promise.resolve(undefined);
    });
  });

  it("U10-1 列产物清单（名称+大小）并接线打开定位", async () => {
    render(<TaskArtifactsPanel taskId="t1" projectRoot="D:\\p" />);
    fireEvent.click(screen.getByText(/任务产物/));
    await waitFor(() => {
      expect(screen.getByText("report.md")).toBeInTheDocument();
      expect(screen.getByText("4.0 KB")).toBeInTheDocument();
      expect(screen.getByText("sub/data.json")).toBeInTheDocument();
    });
    // 打开=资源管理器定位该文件（reveal 命令带绝对路径）。
    fireEvent.click(screen.getAllByText("打开")[0]);
    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith("reveal_in_file_manager", {
        path: FILES[0].abs_path,
      });
    });
  });

  it("U10-2 空产物（历史任务无产物区）——「暂无产物文件」降级不报错", async () => {
    invokeCommand.mockImplementation((cmd: string) =>
      cmd === "task_artifacts_list" ? Promise.resolve([]) : Promise.resolve(undefined),
    );
    render(<TaskArtifactsPanel taskId="nope" projectRoot="D:\\p" />);
    fireEvent.click(screen.getByText(/任务产物/));
    await waitFor(() => {
      expect(screen.getByText("暂无产物文件")).toBeInTheDocument();
    });
  });
});
