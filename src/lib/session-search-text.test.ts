/**
 * 搜索文本（「用户看得见的文字」）单测——v0.9.8 需求23，对应 tests/06-测试清单：
 * S23-U1 用户消息的搜索文本不含内部标记；S23-U2 Markdown 语法不计入搜索文本；
 * S23-U7 普通关键词的可见文字匹配与原文一致。
 */
import { describe, expect, it } from "vitest";

import {
  blockSearchText,
  countMatches,
  markdownVisibleText,
  searchRegExp,
  stripImagePrompt,
  stripTaskLaunchPrefix,
  userVisibleText,
} from "./session-search-text";

const NAMES = { "dev-god": "写后诊断", "skill-a": "方案规划" } as Record<string, string>;
const userBlock = (text: string, tool_ids?: string[]) => ({ type: "text", text, tool_ids });

const IMAGE_MARKERS = [
  "帮我看看这张图里哪个月的访问量最高",
  "<!--JISHU_HUB_IMAGES_BEGIN-->",
  "[用户在本次对话中上传了以下文件，请使用 Read 工具查看对应的文件路径：]",
  "E:\\demo\\.jishu-hub\\session_files\\20261124_230824\\chart.png (image)",
  "<!--JISHU_HUB_IMAGES_END-->",
].join("\n");

/** 一段典型的助手回复：标题、粗斜体、行内代码、链接与图片、列表、任务列表、引用、分隔线、表格。 */
const PROSE = [
  "## 问题清单",
  "",
  "**usePosts.ts** 里是 *串行* 请求，用 `await api.getAuthor()` 逐个取。",
  "",
  "详情见 [贡献指南](https://example.com/docs/CONTRIBUTING.md)，图为 ![柱状图](chart.png)。",
  "",
  "- 第一项",
  "- [x] 第二项",
  "1. 第三项",
  "",
  "> 引用一句话",
  "",
  "---",
  "",
  "| 月份 | 访问量 |",
  "| --- | ---: |",
  "| 5月 | 3,200 |",
  "",
  "~~作废~~ __加粗__ a*b*c #标签",
].join("\n");

const assistant = (text: string) => blockSearchText({ type: "text", text }, "assistant");

describe("用户消息的搜索文本（S23-U1）", () => {
  it("剥掉图片附件标记，只剩用户原话", () => {
    const block = { type: "text", text: IMAGE_MARKERS };
    const visible = blockSearchText(block, "user");
    expect(visible).toBe("帮我看看这张图里哪个月的访问量最高");
    expect(visible).not.toContain("<!--");
    expect(visible).not.toContain("JISHU");
  });

  it("stripImagePrompt 的既有行为不变（气泡显示与搜索同源）", () => {
    expect(stripImagePrompt(IMAGE_MARKERS)).toBe("帮我看看这张图里哪个月的访问量最高");
    expect(stripImagePrompt("第一行\\n第二行")).toBe("第一行\n第二行");
    expect(stripImagePrompt("  没有标记  ")).toBe("没有标记");
  });

  it("内部标记里的文字不计入命中", () => {
    const block = { type: "text", text: IMAGE_MARKERS };
    expect(countMatches(blockSearchText(block, "user"), searchRegExp("session_files"))).toBe(0);
    expect(countMatches(blockSearchText(block, "user"), searchRegExp("访问量"))).toBe(1);
  });
});

describe("助手消息的搜索文本（S23-U2）", () => {
  it("语法符号不进搜索文本", () => {
    const visible = assistant(PROSE);
    for (const syntax of ["##", "**", "`", "](", "example.com", "|", "---", "[x]", "~~", "__"]) {
      expect(visible, `不应包含 ${syntax}`).not.toContain(syntax);
    }
  });

  it("看得见的文字都在，顺序不变", () => {
    const visible = assistant(PROSE);
    expect(visible).toContain("问题清单");
    expect(visible).toContain("usePosts.ts 里是 串行 请求，用 await api.getAuthor() 逐个取。");
    expect(visible).toContain("详情见 贡献指南，图为 柱状图。");
    expect(visible).toContain("第一项\n第二项\n第三项");
    expect(visible).toContain("引用一句话");
    expect(visible).toContain("月份 访问量\n5月 3,200");
    expect(visible).toContain("作废 加粗 a*b*c #标签");
    expect(visible.indexOf("问题清单")).toBeLessThan(visible.indexOf("usePosts.ts"));
    expect(visible.indexOf("usePosts.ts")).toBeLessThan(visible.indexOf("贡献指南"));
  });

  it("围栏代码块只去掉围栏行，内容原样保留", () => {
    const visible = assistant(["说明：", "", "```ts", "// 围栏里的 * _ | # 都是正文", "const a = 1 * 2; // [不是链接](x)", "```", "", "后面的话"].join("\n"));
    expect(visible).toBe(
      ["说明：", "", "// 围栏里的 * _ | # 都是正文", "const a = 1 * 2; // [不是链接](x)", "", "后面的话"].join("\n"),
    );
  });

  it("不是表格的竖线不动", () => {
    expect(assistant("命令 a | b 把结果接给 b")).toBe("命令 a | b 把结果接给 b");
  });
});

describe("普通关键词：可见文字与原文的命中数一致（S23-U7）", () => {
  it("普通词在两边的次数相同", () => {
    for (const word of ["问题清单", "usePosts", "访问量", "贡献指南", "引用", "标签"]) {
      const regex = searchRegExp(word);
      expect(countMatches(assistant(PROSE), regex), word).toBe(countMatches(PROSE, regex));
    }
  });

  it("只出现在语法里的词（链接地址）不数——它渲染后看不见", () => {
    const regex = searchRegExp("example.com");
    expect(countMatches(PROSE, regex)).toBe(1);
    expect(countMatches(assistant(PROSE), regex)).toBe(0);
  });
});

describe("markdownVisibleText 的边界", () => {
  it("空文本与纯文本原样返回", () => {
    expect(markdownVisibleText("")).toBe("");
    expect(markdownVisibleText("一句普通话\n第二行")).toBe("一句普通话\n第二行");
  });

  it("「#标签」这种无空格的井号不算标题", () => {
    expect(markdownVisibleText("#标签 不是标题")).toBe("#标签 不是标题");
    expect(markdownVisibleText("### 是标题")).toBe("是标题");
  });

  it("未闭合的围栏：之后的内容按代码原样保留", () => {
    expect(markdownVisibleText("```md\n# 不是标题")).toBe("# 不是标题");
  });

  it("块对象缓存：同一个块重复取不重算，文字变了会重算", () => {
    const block = { type: "text", text: "**一**" };
    expect(blockSearchText(block, "assistant")).toBe("一");
    block.text = "**二**";
    expect(blockSearchText(block, "assistant")).toBe("二");
  });
});

/**
 * 消息里的工具标签计入搜索文本——v0.9.8 评审修复轮 R2（用户裁决「标签的格式可以
 * 直接搜……搜索时识别原始文本即可」），对应 tests/V-用例清单 V1-U7 / V1-U10 / V1-U12。
 */
describe("用户消息的搜索文本带上工具标签的原始文本", () => {
  it("跟在正文后面的标签按 @[显示名] 接在正文之后，中间没有分隔", () => {
    expect(blockSearchText(userBlock("查一下这段代码", ["dev-god"]), "user", NAMES)).toBe("查一下这段代码@[写后诊断]");
    expect(blockSearchText(userBlock("查一下", ["dev-god", "skill-a"]), "user", NAMES)).toBe("查一下@[写后诊断]@[方案规划]");
  });

  it("正文里的字样本来就是原文；被它覆盖到的工具不再接在后面", () => {
    expect(blockSearchText(userBlock("用 @[方案规划] 排期", ["skill-a", "dev-god"]), "user", NAMES)).toBe(
      "用 @[方案规划] 排期@[写后诊断]",
    );
    expect(blockSearchText(userBlock("用 @[方案规划] 排期", ["skill-a"]), "user", NAMES)).toBe("用 @[方案规划] 排期");
  });

  it("显示名取不到的标签按 id 计（页面上显示的也是 id）；没传映射时全部按 id", () => {
    expect(blockSearchText(userBlock("查", ["ghost"]), "user", NAMES)).toBe("查@[ghost]");
    expect(blockSearchText(userBlock("查", ["dev-god"]), "user")).toBe("查@[dev-god]");
  });

  it("标签搜得到：显示名、@[名]、@[ 各命中一次；别的工具名不命中", () => {
    const text = blockSearchText(userBlock("查一下这段代码", ["dev-god"]), "user", NAMES);
    expect(countMatches(text, searchRegExp("写后诊断"))).toBe(1);
    expect(countMatches(text, searchRegExp("@[写后诊断]"))).toBe(1);
    expect(countMatches(text, searchRegExp("@["))).toBe(1);
    expect(countMatches(text, searchRegExp("方案规划"))).toBe(0);
  });

  it("不带工具的消息与原先完全一样", () => {
    expect(blockSearchText(userBlock("普通消息", []), "user", NAMES)).toBe("普通消息");
    expect(blockSearchText(userBlock("普通消息"), "user", NAMES)).toBe("普通消息");
  });

  it("先剥任务启动包装与图片附件标记，再接标签", () => {
    const raw = ["/jishu-task dev 修复登录问题", "", "<!--JISHU_HUB_IMAGES_BEGIN-->", "x.png", "<!--JISHU_HUB_IMAGES_END-->"].join("\n");
    expect(blockSearchText(userBlock(raw, ["dev-god"]), "user", NAMES)).toBe("修复登录问题@[写后诊断]");
  });

  it("助手消息的 tool_ids 不影响搜索文本", () => {
    expect(blockSearchText(userBlock("**一**", ["dev-god"]), "assistant", NAMES)).toBe("一");
  });

  it("缓存：工具集或工具名映射换了会重算", () => {
    const block = userBlock("查", ["dev-god"]);
    expect(blockSearchText(block, "user")).toBe("查@[dev-god]");
    expect(blockSearchText(block, "user", NAMES)).toBe("查@[写后诊断]");
    block.tool_ids = ["skill-a"];
    expect(blockSearchText(block, "user", NAMES)).toBe("查@[方案规划]");
  });
});

/** 用户消息里用户看得见的正文——气泡显示与搜索同一份。 */
describe("用户看得见的正文", () => {
  it("剥掉任务启动包装（内部路由指令不属于用户原话）", () => {
    expect(stripTaskLaunchPrefix("/jishu-task dev 修复登录问题")).toBe("修复登录问题");
    expect(stripTaskLaunchPrefix("/jishu-task research 调研一下")).toBe("调研一下");
    expect(stripTaskLaunchPrefix("/jishu-task 直接开始")).toBe("直接开始");
    expect(stripTaskLaunchPrefix("普通消息 /jishu-task 不在开头")).toBe("普通消息 /jishu-task 不在开头");
  });

  it("先剥包装、再剥图片附件标记", () => {
    expect(userVisibleText(["/jishu-task dev 看这张图", "<!--JISHU_HUB_IMAGES_BEGIN-->x<!--JISHU_HUB_IMAGES_END-->"].join("\n"))).toBe(
      "看这张图",
    );
  });
});

describe("助手消息里的装备推荐块不进搜索文本（二轮评审 R3 P2-11）", () => {
  const assistantBlock = (text: string) => ({ type: "text", text, tool_ids: undefined as string[] | undefined });
  const RECOMMEND =
    '<JISHU-EQUIP-RECOMMEND>{"items":[{"ref":"curated:task-plan","reason":"适合做流程规划"}],"profile":{"scene":"coding","keywords":["流程规划"]}}</JISHU-EQUIP-RECOMMEND>';

  it("推荐块里的 JSON 不显示，不计入搜索文本：只取看得见的文字段", () => {
    const text = `先聊聊流程规划的思路。\n\n${RECOMMEND}\n\n需要的话告诉我。`;
    const visible = blockSearchText(assistantBlock(text), "assistant");
    // 修前：整段按 Markdown 投影——块里理由与画像关键词里的「流程规划」被数成命中，页面上却没有这段文字
    expect(countMatches(visible, searchRegExp("流程规划"))).toBe(1);
    expect(visible).not.toContain("JISHU-EQUIP-RECOMMEND");
    expect(visible).not.toContain("task-plan");
    expect(visible).toContain("先聊聊流程规划的思路。");
    expect(visible).toContain("需要的话告诉我。");
  });

  it("JSON 非法的推荐块页面上不渲染，同样不计入；没有推荐块的助手消息与原先一样", () => {
    const broken = `前一句\n<JISHU-EQUIP-RECOMMEND>{not json}</JISHU-EQUIP-RECOMMEND>\n后一句`;
    const visible = blockSearchText(assistantBlock(broken), "assistant");
    expect(visible).not.toContain("not json");
    expect(visible).toContain("前一句");
    expect(visible).toContain("后一句");
    expect(blockSearchText(assistantBlock("# 标题\n\n正文"), "assistant")).toBe(markdownVisibleText("# 标题\n\n正文"));
  });
});
