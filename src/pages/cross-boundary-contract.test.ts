/**
 * 跨端契约对照测试（修复轮回归收口）：后端 struct 序列化字段名 ↔ 前端
 * TS 接口/消费点字段名必须逐字段一致。
 *
 * 来源教训：camelCase→snake_case 统一时后端改了 `has_update`、前端 14 处
 * 仍读 `hasUpdate`——tsc 管不到跨端、组件 mock 自洽骗过 vitest、CDP 自测
 * 没走到该路径，三道验证全漏（更新检测整链哑掉）。本测试从 Rust 源码
 * 提取 struct 字段名，与前端接口声明对锚——字段漂移在此变成红灯而非
 * 用户实测才发现。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..");
const piindexRs = readFileSync(join(repoRoot, "src-tauri", "src", "agent", "piindex.rs"), "utf-8");
const marketPageTs = readFileSync(join(repoRoot, "src", "pages", "plugin-market.tsx"), "utf-8");
const updatesTs = readFileSync(join(repoRoot, "src", "pages", "plugin-market-updates.ts"), "utf-8");
const sessionBindingRs = readFileSync(join(repoRoot, "src-tauri", "src", "task_launch", "session_binding.rs"), "utf-8");
const chatInputTs = readFileSync(join(repoRoot, "src", "components", "sessions", "chat-input.tsx"), "utf-8");

/** 提取 Rust struct 的字段名（`pub name: Type,` → name）。 */
function rustStructFields(rs: string, struct: string): string[] {
  const m = rs.match(new RegExp(`pub struct ${struct} \\{([^}]*)\\}`));
  if (!m) throw new Error(`struct ${struct} not found in piindex.rs`);
  return [...m[1].matchAll(/^\s*pub (\w+):/gm)].map((x) => x[1]);
}

/** 提取前端 TS interface 的字段名。 */
function tsInterfaceFields(ts: string, iface: string): string[] {
  const m = ts.match(new RegExp(`interface ${iface} \\{([^}]*)\\}`));
  if (!m) throw new Error(`interface ${iface} not found`);
  return [...m[1].matchAll(/^\s*(\w+)[?]?:/gm)].map((x) => x[1]);
}

describe("跨端契约：piindex 更新状态字段（snake_case 冻结口径）", () => {
  it("ExtensionUpdateStatus：Rust ↔ TS 逐字段一致", () => {
    expect(tsInterfaceFields(updatesTs, "ExtensionUpdateStatus")).toEqual(
      rustStructFields(piindexRs, "ExtensionUpdateStatus"),
    );
  });

  it("SkillUpdateStatus：Rust ↔ TS 逐字段一致", () => {
    expect(tsInterfaceFields(updatesTs, "SkillUpdateStatus")).toEqual(
      rustStructFields(piindexRs, "SkillUpdateStatus"),
    );
  });

  it("PiindexEntry：Rust ↔ TS 逐字段一致", () => {
    expect(tsInterfaceFields(marketPageTs, "PiindexEntry")).toEqual(
      rustStructFields(piindexRs, "PiindexEntry"),
    );
  });

  it("camelCase 旧键全仓无残留（hasUpdate/npmPackage/downloadTrend 等）", () => {
    const camelKeys = ["hasUpdate", "npmPackage", "installCommand", "githubUrl", "kindLabel", "detailUrl", "weeklyDownloads", "downloadTrend"];
    for (const key of camelKeys) {
      expect(marketPageTs, `plugin-market.tsx 不应再出现 ${key}`).not.toContain(key);
      expect(
        readFileSync(join(repoRoot, "src", "pages", "plugin-market-updates.ts"), "utf-8"),
        `plugin-market-updates.ts 不应再出现 ${key}`,
      ).not.toContain(key);
    }
  });

  it("批量更新报告字段：{updated, failed[{name, error}]}（前端消费点形状锚定）", () => {
    // 前端四处消费点的内联类型与后端 BatchUpdateReport 冻结形状一致。
    const m = piindexRs.match(/pub struct BatchUpdateReport \{([\s\S]*?)\n\}/);
    expect(m, "BatchUpdateReport 应存在于 piindex.rs").toBeTruthy();
    const fields = [...m![1].matchAll(/^\s*pub (\w+):/gm)].map((x) => x[1]).sort();
    expect(fields).toEqual(["failed", "updated"]);
    const failItem = rustStructFields(piindexRs, "BatchUpdateFailure").sort();
    expect(failItem).toEqual(["error", "name"]);
  });
});

describe("跨端契约：任务模式首条消息的任务意图（嵌套参数，键名 Tauri 不做驼峰转换）", () => {
  it("TaskLaunchIntent：Rust 字段 ↔ 前端放上线路的键 逐字段一致", () => {
    // 收口轮教训：前端传了驼峰（skillId）、后端要下划线（skill_id），参数校验直接拒绝——每个新任务的第一条
    // 消息都发不出去，界面停在「正在赶来」。两边各自的替身都自洽，单测全绿；只有把两边的字段名放在一起比才露馅。
    expect(tsInterfaceFields(chatInputTs, "ChatInputTaskLaunch")).toEqual(
      rustStructFields(sessionBindingRs, "TaskLaunchIntent"),
    );
  });
});
