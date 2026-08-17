import { describe, expect, it } from "vitest";
import {
  PROVIDER_PRESETS,
  matchPresetByBaseUrl,
  presetModelToEntry,
  suggestProviderKey,
} from "./provider-presets";
import { applyProxyPresetToEnv, removeProxyEnv, CLAUDE_PROXY_PRESETS } from "./claude-presets";

describe("PROVIDER_PRESETS registry", () => {
  it("contains custom fallback and at least four real providers", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toContain("custom");
    expect(PROVIDER_PRESETS.filter((p) => p.id !== "custom").length).toBeGreaterThanOrEqual(4);
  });

  it("every non-custom preset has baseUrl, api and at least one model", () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.id === "custom") continue;
      expect(p.baseUrl).toMatch(/^https:\/\//);
      expect(p.api).toBeTruthy();
      expect(p.models.length).toBeGreaterThan(0);
    }
  });

  it("model ids are unique within a preset", () => {
    for (const p of PROVIDER_PRESETS) {
      const ids = p.models.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("matchPresetByBaseUrl", () => {
  it("matches ignoring trailing slash and case", () => {
    expect(matchPresetByBaseUrl("https://open.bigmodel.cn/api/anthropic/")?.id).toBe("zhipu");
    expect(matchPresetByBaseUrl("HTTPS://API.DEEPSEEK.COM/ANTHROPIC")?.id).toBe("deepseek");
  });

  it("returns null for unknown or empty urls", () => {
    expect(matchPresetByBaseUrl("https://example.com/api")).toBeNull();
    expect(matchPresetByBaseUrl("")).toBeNull();
    expect(matchPresetByBaseUrl(undefined)).toBeNull();
  });
});

describe("suggestProviderKey", () => {
  it("uses preset id when free", () => {
    expect(suggestProviderKey(PROVIDER_PRESETS[0], ["other"])).toBe("zhipu");
  });

  it("appends a number on collision", () => {
    const zhipu = PROVIDER_PRESETS[0];
    expect(suggestProviderKey(zhipu, ["zhipu"])).toBe("zhipu2");
    expect(suggestProviderKey(zhipu, ["zhipu", "zhipu2"])).toBe("zhipu3");
  });

  it("returns empty for custom preset", () => {
    const custom = PROVIDER_PRESETS.find((p) => p.id === "custom")!;
    expect(suggestProviderKey(custom, [])).toBe("");
  });
});

describe("presetModelToEntry", () => {
  it("fills schema-required cost zeros and optional params", () => {
    const entry = presetModelToEntry({
      id: "glm-5.3",
      displayName: "GLM-5.3",
      contextWindow: 200000,
      maxTokens: 32768,
      reasoning: true,
    });
    expect(entry.id).toBe("glm-5.3");
    expect(entry.contextWindow).toBe(200000);
    expect(entry.maxTokens).toBe(32768);
    expect(entry.reasoning).toBe(true);
    expect(entry.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("omits optional params when absent", () => {
    const entry = presetModelToEntry({ id: "m", displayName: "M" });
    expect(entry.contextWindow).toBeUndefined();
    expect(entry.maxTokens).toBeUndefined();
  });
});

describe("claude proxy presets", () => {
  it("excludes official anthropic and custom, keeps custom entry last", () => {
    expect(CLAUDE_PROXY_PRESETS.some((p) => p.id === "anthropic")).toBe(false);
    expect(CLAUDE_PROXY_PRESETS[CLAUDE_PROXY_PRESETS.length - 1].id).toBe("custom");
  });

  it("all proxy endpoints are anthropic-compatible paths", () => {
    for (const p of CLAUDE_PROXY_PRESETS) {
      if (p.custom) continue;
      expect(p.baseUrl).toMatch(/\/anthropic\/?$/i);
    }
  });

  it("applyProxyPresetToEnv merges without touching unrelated keys", () => {
    const preset = CLAUDE_PROXY_PRESETS.find((p) => p.id === "zhipu")!;
    const env = applyProxyPresetToEnv(preset, "sk-test", {
      ANTHROPIC_BASE_URL: "https://old.example.com",
      MY_OTHER_VAR: "keep",
    });
    expect(env["ANTHROPIC_BASE_URL"]).toBe(preset.baseUrl);
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("sk-test");
    expect(env["ANTHROPIC_MODEL"]).toBe(preset.model);
    expect(env["MY_OTHER_VAR"]).toBe("keep");
  });

  it("custom preset is a no-op", () => {
    const custom = CLAUDE_PROXY_PRESETS.find((p) => p.custom)!;
    expect(applyProxyPresetToEnv(custom, "sk", { A: "1" })).toEqual({ A: "1" });
  });

  it("removeProxyEnv strips only proxy keys", () => {
    const next = removeProxyEnv({
      ANTHROPIC_BASE_URL: "x",
      ANTHROPIC_MODEL: "y",
      OTHER: "z",
    });
    expect(next).toEqual({ OTHER: "z" });
  });
});
