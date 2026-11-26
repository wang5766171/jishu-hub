/**
 * i18n 覆盖守卫（收版反馈 2026-11-12：用户实测「删除智能体时文案没翻译」
 * ——t() 缺 key 直接露出 key 原文）。静态扫描 src 下所有 t("ns.key") 调用，
 * 断言 zh/en 两份语言包全覆盖。
 *
 * 限制：动态 key（t(variable)）不在静态可达范围；带 defaultValue 的调用
 * 在中文界面有兜底，但英文界面会显示中文兜底——同样视为缺失（口径从严）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..", "..", "src");

function dig(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (typeof cur !== "object" || cur === null || !(part in (cur as Record<string, unknown>))) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function collectTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "i18n" || name === "node_modules" || name.includes(".test.")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsxFiles(full));
    } else if (/\.(tsx?|ts)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("i18n 覆盖守卫", () => {
  it("所有静态 t() key 在 zh/en 语言包中都有翻译", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const zh = JSON.parse(readFileSync(join(__dirname, "zh.json"), "utf-8"));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const en = JSON.parse(readFileSync(join(__dirname, "en.json"), "utf-8"));
    const used = new Map<string, string>();
    const pat = /\bt\(\s*["']([a-zA-Z0-9_.\-]+)["']/g;
    for (const file of collectTsxFiles(ROOT)) {
      const text = readFileSync(file, "utf-8");
      let m: RegExpExecArray | null;
      while ((m = pat.exec(text)) !== null) {
        if (!used.has(m[1])) used.set(m[1], relative(ROOT, file).split(sep).join("/"));
      }
    }
    expect(used.size).toBeGreaterThan(500); // 扫描本身健全性（数量级回归即报警）
    const missing: string[] = [];
    for (const [key, file] of used) {
      if (dig(zh, key) === undefined || dig(en, key) === undefined) {
        missing.push(`${key} (${file})`);
      }
    }
    expect(missing, `缺翻译 key：\n${missing.join("\n")}`).toEqual([]);
  });

  it("模版卡的 nameKey 在 zh / en 里都有（英文界面不显示中文回退）", () => {
    // 二轮评审 R3（域 3 P1-2）：这些键经 nameKey 属性 + tr() 取值，上面的扫描只认 t("…")——
    // 9 张模版卡里 6 张在英文界面显示中文名，守卫没拦住。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const zh = JSON.parse(readFileSync(join(__dirname, "zh.json"), "utf-8"));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const en = JSON.parse(readFileSync(join(__dirname, "en.json"), "utf-8"));
    const text = readFileSync(join(ROOT, "pages/plugin-create-dialog-templates.tsx"), "utf-8");
    const keys = [...text.matchAll(/nameKey:\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(9);
    const missing = keys.filter((key) => dig(zh, key) === undefined || dig(en, key) === undefined);
    expect(missing, `模版卡名字缺翻译：${missing.join(", ")}`).toEqual([]);
  });
});
