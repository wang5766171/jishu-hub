/**
 * mermaid 导出规范化单测（v0.9.2 测试期二轮增强）：
 * buildExportSvg 补 xmlns / 显式宽高 / 去 style 是 PNG 栅格化成败的关键
 * （mermaid 根节点常为 width="100%" 且缺 xmlns → img 加载失败或尺寸为 0）。
 */
import { describe, expect, it } from "vitest";
import {
  buildExportSvg,
  foreignObjectsToText,
  mermaidErrorBrief,
  parseSvgSize,
  wellFormSvgXml,
} from "./mermaid-export";

const MERMAID_LIKE_SVG =
  '<svg id="d1" width="100%" style="max-width: 512px;" viewBox="0 0 512 384"><g><text>登录</text></g></svg>';

describe("mermaidErrorBrief", () => {
  it("takes the first non-empty line of a multi-line parse error", () => {
    const err = new Error("Parse error on line 3:\nflowchart TD\n    A ->> B\nExpecting 'SQE', got 'EOF'");
    expect(mermaidErrorBrief(err)).toBe("Parse error on line 3:");
  });

  it("truncates over-long first lines", () => {
    const long = "x".repeat(500);
    const brief = mermaidErrorBrief(new Error(long));
    expect(brief.length).toBe(201);
    expect(brief.endsWith("…")).toBe(true);
  });

  it("stringifies non-error values", () => {
    expect(mermaidErrorBrief(42)).toBe("42");
  });
});

describe("parseSvgSize", () => {
  it("prefers viewBox over width=100%", () => {
    expect(parseSvgSize(MERMAID_LIKE_SVG)).toEqual({ width: 512, height: 384 });
  });

  it("falls back to explicit pixel attrs when no viewBox", () => {
    expect(parseSvgSize('<svg width="300" height="150"></svg>')).toEqual({
      width: 300,
      height: 150,
    });
  });

  it("falls back to 800x600 on non-svg input", () => {
    expect(parseSvgSize("not-an-svg")).toEqual({ width: 800, height: 600 });
  });
});

describe("buildExportSvg", () => {
  it("adds xmlns, explicit pixel size, and strips style", () => {
    const { svg, width, height } = buildExportSvg(MERMAID_LIKE_SVG);
    expect(width).toBe(512);
    expect(height).toBe(384);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="512"');
    expect(svg).toContain('height="384"');
    expect(svg).not.toContain("max-width");
    expect(svg).not.toContain('width="100%"');
    // 内容保留
    expect(svg).toContain("登录");
  });

  it("keeps existing xmlns untouched", () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect/></svg>';
    const { svg } = buildExportSvg(source);
    expect(svg.match(/xmlns=/g)?.length).toBe(1);
    expect(svg).toContain('width="100"');
  });

  it("normalizes via string surgery (XML-fragile foreignObject survives)", () => {
    // mermaid htmlLabels 产物含未闭合 <br>（非良构 XML，DOMParser 会产
    // parsererror）——字符串手术必须原样保留内容。
    const source =
      '<svg width="100%" style="max-width: 300px;" viewBox="0 0 300 200"><foreignObject><div>行1<br>行2</div></foreignObject></svg>';
    const { svg, width, height } = buildExportSvg(source);
    expect(width).toBe(300);
    expect(height).toBe(200);
    expect(svg).toContain("<br>");
    expect(svg).toContain('width="300"');
    expect(svg).not.toContain("max-width");
  });

  it("returns non-svg input unchanged without throwing", () => {
    const { svg, width, height } = buildExportSvg("plain-text");
    expect(svg).toBe("plain-text");
    expect(width).toBe(800);
    expect(height).toBe(600);
  });
});

describe("foreignObjectsToText", () => {
  it("converts a foreignObject label to a centered multi-line <text>", () => {
    const source =
      '<g transform="translate(10,20)"><foreignObject width="100" height="40"><div><span>行一<br>行二</span></div></foreignObject></g>';
    const out = foreignObjectsToText(source);
    expect(out).not.toContain("foreignObject");
    expect(out).not.toContain("<br");
    expect(out).toContain('<text class="edgeLabel" x="50" y="20"');
    expect(out).toContain('<tspan x="50" dy="-0.625em">行一</tspan>');
    expect(out).toContain('<tspan x="50" dy="1.25em">行二</tspan>');
  });

  it("respects x/y offset attrs when present", () => {
    const source =
      '<foreignObject x="10" y="5" width="100" height="40"><div>标签</div></foreignObject>';
    const out = foreignObjectsToText(source);
    expect(out).toContain('x="60" y="25"');
  });

  it("unescapes entities then re-escapes for XML", () => {
    const source =
      '<foreignObject width="50" height="20"><div>a &lt;b&gt; &amp;&amp; c</div></foreignObject>';
    const out = foreignObjectsToText(source);
    expect(out).toContain("a &lt;b&gt; &amp;&amp; c");
  });

  it("removes empty foreignObjects entirely", () => {
    const source = '<foreignObject width="10" height="10"><div></div></foreignObject>ok';
    expect(foreignObjectsToText(source)).toBe("ok");
  });

  it("real-world export: no foreignObject, no <br>, well-formed tag structure", () => {
    // 结构回归（真实导出形态的浓缩样本：嵌套 p/span、双边框标签）
    const sample = `<svg viewBox="0 0 100 60">
      <g class="edgeLabel"><foreignObject width="90" height="24"><div><span class="edgeLabel"><p>确认需求</p></span></div></foreignObject></g>
      <g><foreignObject width="80" height="30"><div><span class="nodeLabel"><p>开发实现<br/>联调测试</p></span></div></foreignObject></g>
    </svg>`;
    const out = foreignObjectsToText(sample);
    expect(out).not.toContain("foreignObject");
    expect(out).not.toContain("<br");
    expect(out.match(/<text /g)?.length).toBe(2);
  });
});

describe("wellFormSvgXml", () => {
  it("self-cases <br> variants and <img>, prepends XML declaration", () => {
    const out = wellFormSvgXml('<svg><foreignObject><div>行1<br>行2</div></foreignObject><img src="x.png"></svg>');
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(out).toContain("行1<br/>行2");
    expect(out).toContain('<img src="x.png"/>');
    expect(out).not.toMatch(/<br>/);
    expect(out).not.toMatch(/<img src="x.png">/);
  });

  it("leaves already-closed tags untouched", () => {
    const out = wellFormSvgXml("<svg><br/><img src=\"y\"/></svg>");
    expect(out).toContain("<br/><img");
    expect(out.match(/<br\/>/g)?.length).toBe(1);
  });
});
