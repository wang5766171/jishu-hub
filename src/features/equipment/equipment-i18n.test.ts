/**
 * v0.9.8 评审修复轮 R3（二轮评审 P2-14 a / b / d）：装备 / 市场这一片的词典一致性。
 * a. 同一页里对同一个东西只用一个名称（「输入框建议」）。
 * b. 市场套装弹层与会话推荐卡是同一句汇总，英文只能是同一套说法。
 * d. 安装出口不再有英文内部话（见 install.test.ts 的 P2-7-U1）。
 */
import { describe, expect, it } from "vitest";
import zh from "@/i18n/zh.json";
import en from "@/i18n/en.json";

type Dict = Record<string, Record<string, string>>;
const ZH = zh as unknown as Dict;
const EN = en as unknown as Dict;

describe("装备 / 市场词典一致性", () => {
  it("P2-14a 同一页的名称一致：重置说明里用的就是该页对它的称呼", () => {
    // 修前：重置说明写「输入框建议条」，同一页的开关名是「输入框建议」
    expect(ZH.equip.cfgInputBar).toBe("输入框建议");
    expect(ZH.equip.cfgResetDesc).toContain(ZH.equip.cfgInputBar);
    expect(ZH.equip.cfgResetDesc).not.toContain("输入框建议条");
    // 英文本来就是一致的（句中小写），守住
    expect(EN.equip.cfgResetDesc.toLowerCase()).toContain(EN.equip.cfgInputBar.toLowerCase());
  });

  it("P2-14b 套装弹层与推荐卡的汇总句：中文相同，英文也是同一套说法", () => {
    expect(ZH.market.bundleDone).toBe(ZH.equip.installDone);
    expect(ZH.market.bundleDoneSkipped).toBe(ZH.equip.installDoneSkipped);
    // 修前：市场「Done: …」对推荐卡「Install finished: …」
    expect(EN.market.bundleDone).toBe(EN.equip.installDone);
    expect(EN.market.bundleDoneSkipped).toBe(EN.equip.installDoneSkipped);
    expect(EN.market.bundleDone.startsWith("Install finished:")).toBe(true);
  });

  it("本轮新增的键 zh / en 齐备，且说明文字不暴露内部代号", () => {
    const keys = [
      "equip.installResultUnknown",
      "equip.installRefUnknown",
      "equip.installedUnreadable",
      "market.installedUnknown",
      "market.installedUnreadable",
      "onboarding.installedUnknown",
    ];
    for (const key of keys) {
      const [ns, name] = key.split(".");
      for (const dict of [ZH, EN]) {
        const text = dict[ns]?.[name];
        expect(text, `${key} 缺失或为空`).toBeTruthy();
        expect(text).not.toMatch(/\bpi\b|installRef|unknown ref|\{\{|\}\}/i);
      }
    }
    // 「状态未知」是形态名，两种语言都只有一个说法
    expect(ZH.market.installedUnknown).toBe("状态未知");
  });
});
