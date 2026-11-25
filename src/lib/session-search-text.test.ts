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
} from "./session-search-text";

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
