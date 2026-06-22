import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("advance_phase.mjs", () => {
  it("passes requirement markdown through stdin instead of a command-line argument", () => {
    const script = readFileSync(
      resolve("src-tauri/resources/task-plan/jishu-task-planner/scripts/advance_phase.mjs"),
      "utf8",
    );

    expect(script).toContain('cliArgs.push("--requirement", "-")');
    expect(script).toMatch(/execFileSync\(cliBin,\s*cliArgs,\s*\{[\s\S]*input:\s*requirementMarkdown/);
    expect(script).not.toContain('cliArgs.push("--requirement", requirementMarkdown)');
  });
});
