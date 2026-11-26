// v0.9.8 需求5（合并版）：装备推荐纯函数测试（块解析 / L0/L1 匹配 / 目录合并）。
import { describe, expect, it } from "vitest";
import {
  extractEquipSegments,
  type EquipRecommendPayload,
} from "@/components/sessions/equip-recommend-card";
import {
  buildCatalog,
  installCommandFor,
  matchByProfile,
  matchByTags,
  matchByWorkspaceScene,
  officialFallback,
} from "@/features/equipment/match";
import type { CatalogEntry, TaskProfile } from "@/features/equipment/api";

const CATALOG: CatalogEntry[] = [
  { ref: "curated:pi-lens", title: "写后诊断", tags: ["代码检查", "找定义"], stars: 4, kind: "pi-package" },
  { ref: "curated:session.video-maker", title: "视频生成助手", tags: ["视频生成", "分镜"], stars: 5, kind: "composed" },
  { ref: "skillhub:tts", title: "语音合成", tags: ["配音", "语音"], stars: 3 },
  { ref: "curated:weak", title: "弱信号件", tags: ["代码检查"], stars: 2 },
];

describe("extractEquipSegments（组套协议块解析）", () => {
  const payload: EquipRecommendPayload = {
    items: [{ ref: "curated:pi-lens", reason: "你要做代码体检" }],
    profile: { scene: "programming", keywords: ["体检"] },
  };
  const block = `<JISHU-EQUIP-RECOMMEND>${JSON.stringify(payload)}</JISHU-EQUIP-RECOMMEND>`;

  it("纯文本无块 → 单文本段", () => {
    expect(extractEquipSegments("普通回复")).toHaveLength(1);
    expect(extractEquipSegments("普通回复")[0].type).toBe("text");
  });

  it("完整块 → 文本+推荐+文本三段，payload 解析无损", () => {
    const segs = extractEquipSegments(`开头说明\n\n${block}\n\n结尾`);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ type: "text", content: "开头说明" });
    const rec = segs[1];
    if (rec.type !== "recommend") throw new Error("expect recommend");
    expect(rec.payload.items[0].ref).toBe("curated:pi-lens");
    expect(rec.payload.profile?.keywords).toEqual(["体检"]);
    expect(segs[2]).toEqual({ type: "text", content: "结尾" });
  });

  it("流式半写（无闭合标记）→ 整段按文本处理", () => {
    const partial = "说明\n<JISHU-EQUIP-RECOMMEND>{\"items\":[{";
    const segs = extractEquipSegments(partial);
    expect(segs.every((s) => s.type === "text")).toBe(true);
  });

  it("块内 JSON 非法 → 静默丢弃块只留文本", () => {
    const bad = "<JISHU-EQUIP-RECOMMEND>不是JSON</JISHU-EQUIP-RECOMMEND>后续文本";
    const segs = extractEquipSegments(bad);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("text");
    expect((segs[0] as { content: string }).content).toBe("后续文本");
  });
});

describe("L0 matchByTags（零推理本地匹配）", () => {
  const input = { catalog: CATALOG, installedRefs: new Set<string>(["curated:session.video-maker"]) };

  it("标签子串命中 + 星级加权排序 + 已装排除", () => {
    const hits = matchByTags("帮我做一次代码检查", input, 3);
    expect(hits.map((h) => h.entry.ref)).toEqual(["curated:pi-lens"]); // weak(★2)被排除
    expect(hits[0].hitTags).toEqual(["代码检查"]);
  });

  it("英文标签忽略大小写命中", () => {
    const catalog: CatalogEntry[] = [
      { ref: "skillhub:x", title: "X", tags: ["TTS"], stars: 3 },
    ];
    const hits = matchByTags("我需要 tts 配音", { catalog, installedRefs: new Set() }, 3);
    expect(hits).toHaveLength(1);
  });

  it("officialOnly 过滤第三方件", () => {
    const hits = matchByTags("我要配音", { ...input, officialOnly: true }, 3);
    expect(hits).toHaveLength(0);
  });

  it("文本过短（<2 字符）不匹配", () => {
    expect(matchByTags("查", input)).toHaveLength(0);
  });

  /** v0.9.8 评审修复轮 R2 / M-11：子串匹配没有边界——短英文标签会命中别的单词
   *  的一部分（「AI」命中 said、detail）。纯英文 / 数字标签按整词命中；中文短语
   *  仍按子串（设计 §3.1），汉字不算词内字符。 */
  it("M11-1 英文标签按整词命中；中文短语仍按子串命中", () => {
    const catalog: CatalogEntry[] = [
      { ref: "curated:ai", title: "AI 助手", tags: ["AI"], stars: 4 },
      { ref: "curated:ppt", title: "PPT 助手", tags: ["PPT"], stars: 4 },
      { ref: "curated:code", title: "写后诊断", tags: ["代码检查"], stars: 4 },
    ];
    const boundary = { catalog, installedRefs: new Set<string>() };
    const refs = (text: string) => matchByTags(text, boundary, 3).map((h) => h.entry.ref);
    // 「ai」只是别的单词的一部分：不命中
    expect(refs("please explain the details")).toEqual([]);
    expect(refs("what he said")).toEqual([]);
    // 整词出现：命中
    expect(refs("用 AI 写一段")).toEqual(["curated:ai"]);
    // 汉字不算词内字符
    expect(refs("帮我做个PPT模板")).toEqual(["curated:ppt"]);
    // 中文短语：子串即命中
    expect(refs("做一次代码检查")).toEqual(["curated:code"]);
  });
});

describe("L0.5 matchByWorkspaceScene（工作区场景匹配——按项目定位）", () => {
  const catalog: CatalogEntry[] = [
    { ref: "curated:task-plan", title: "流程规划", tags: ["任务拆解"], stars: 5, scenes: ["programming"] },
    { ref: "curated:session.video-maker", title: "视频生成助手", tags: ["视频生成"], stars: 5, scenes: ["video"] },
    { ref: "curated:other", title: "无场景件", tags: ["x"], stars: 4 },
  ];

  it("代码目录→编程件；视频目录→视频件；未装排除", () => {
    const input = { catalog, installedRefs: new Set<string>(["curated:task-plan"]) };
    // programming：task-plan 已装 → 空。
    expect(matchByWorkspaceScene("programming", input, 3)).toHaveLength(0);
    // video：video-maker 未装 → 命中。
    const picks = matchByWorkspaceScene("video", input, 3);
    expect(picks.map((e) => e.ref)).toEqual(["curated:session.video-maker"]);
    // 无场景归属场景（如 content 无 curated 件）→ 空（走下一级）。
    expect(matchByWorkspaceScene("content", input, 3)).toHaveLength(0);
  });
});

describe("L1 matchByProfile（画像消费）", () => {
  const profile: TaskProfile = {
    session_id: "s1",
    scene: "video",
    keywords: ["产品介绍", "配音", "视频生成"],
    updated_at: 1,
  };

  it("关键词命中 ×2 权重 + 已装排除（video-maker 已装不荐）", () => {
    const hits = matchByProfile(profile, { catalog: CATALOG, installedRefs: new Set(["curated:session.video-maker"]) }, 6);
    expect(hits.map((h) => h.entry.ref)).toEqual(["skillhub:tts"]);
  });
});

describe("officialFallback（入门推荐兜底）", () => {
  it("curated 未装件按星级排序；★2 不进", () => {
    const picks = officialFallback({ catalog: CATALOG, installedRefs: new Set(["curated:session.video-maker"]) }, 3);
    expect(picks.map((p) => p.ref)).toEqual(["curated:pi-lens", "curated:weak"].filter((r) => r !== "curated:weak"));
    expect(picks[0].stars).toBeGreaterThanOrEqual(picks[picks.length - 1].stars);
  });
});

describe("buildCatalog（目录合并：官方 curated + 第三方标签库）", () => {
  it("required 件不入目录；curated ref 防御性跳过标签库行（防双真源）", () => {
    const catalog = buildCatalog(
      [
        { id: "a", kind: "agent", title: "A", description: "d", required: false, tags: ["x"], stars: 5 },
        { id: "core", kind: "agent", title: "Core", description: "d", required: true },
      ],
      [
        { ref: "skillhub:s", title: "S", tags: ["y"], stars: 3 },
        { ref: "curated:a", title: "伪造官方行", tags: ["z"], stars: 5 },
      ],
    );
    expect(catalog.map((c) => c.ref)).toEqual(["curated:a", "skillhub:s"]);
    expect(catalog[0].title).toBe("A");
  });
});

describe("installCommandFor（ref → 安装命令分派）", () => {
  it("三前缀分派正确；未知前缀返回 null", () => {
    expect(installCommandFor("curated:pi-lens")?.command).toBe("market_install");
    expect(installCommandFor("skillhub:pmaster")?.command).toBe("skillhub_install");
    expect(installCommandFor("pi:npm:pkg-x")?.command).toBe("pi_package_install_online");
    expect(installCommandFor("unknown:x")).toBeNull();
  });
});
