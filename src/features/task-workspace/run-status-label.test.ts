/**
 * 运行状态词面单测（RS-U3）：六种有词面的运行状态中英文各是什么；
 * 没有运行状态、空串、不认识的取值 → null（不臆造词面、不回显取值原文）。
 */
import i18n from "@/i18n";
import { afterEach, describe, expect, it } from "vitest";

import { runStatusLabel } from "./run-status-label";

const cases: Array<[string, string, string]> = [
  ["running", "执行中", "Running"],
  ["paused", "已暂停", "Paused"],
  ["awaiting_human", "等待审批", "Awaiting approval"],
  ["completed", "已完成", "Completed"],
  ["failed", "失败", "Failed"],
  ["cancelled", "已取消", "Cancelled"],
];

afterEach(async () => {
  await i18n.changeLanguage("zh");
});

describe("运行状态词面", () => {
  it("中文：六种运行状态各是各的词面", () => {
    for (const [status, label] of cases) {
      expect(runStatusLabel(i18n.t, status), status).toBe(label);
    }
  });

  it("英文：六种运行状态各是各的词面", async () => {
    await i18n.changeLanguage("en");
    for (const [status, , label] of cases) {
      expect(runStatusLabel(i18n.t, status), status).toBe(label);
    }
  });

  it.each([null, undefined, "", "draft", "ready", "bogus", "Completed"])(
    "没有运行状态或不认识的取值 %s → null",
    (status) => {
      expect(runStatusLabel(i18n.t, status)).toBeNull();
    },
  );
});
