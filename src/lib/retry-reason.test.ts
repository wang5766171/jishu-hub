import { describe, expect, it } from "vitest";
import { classifyRetryError } from "./retry-reason";

/** v0.9.1 需求14 测试期：重试原因分类——常见瞬时性错误特征归档，
 * 未命中回通用档（横幅前缀友好文案的数据源）。 */
describe("classifyRetryError", () => {
  it("maps common transient error patterns to categories", () => {
    expect(classifyRetryError("connect ECONNREFUSED 127.0.0.1:1")).toBe("sessions.retryReason.network");
    expect(classifyRetryError("fetch failed: Connection refused")).toBe("sessions.retryReason.network");
    expect(classifyRetryError("getaddrinfo ENOTFOUND api.invalid")).toBe("sessions.retryReason.dns");
    expect(classifyRetryError("Request timed out after 30000ms")).toBe("sessions.retryReason.timeout");
    expect(classifyRetryError("read ETIMEDOUT")).toBe("sessions.retryReason.timeout");
    expect(classifyRetryError("socket hang up")).toBe("sessions.retryReason.reset");
    expect(classifyRetryError("HTTP 429: rate limit exceeded")).toBe("sessions.retryReason.rateLimit");
    expect(classifyRetryError("503 Service Unavailable")).toBe("sessions.retryReason.server");
    expect(classifyRetryError("Bad Gateway (502)")).toBe("sessions.retryReason.server");
    expect(classifyRetryError("401 Unauthorized")).toBe("sessions.retryReason.auth");
  });

  it("falls back to the generic category", () => {
    expect(classifyRetryError("some unexpected provider error")).toBe("sessions.retryReason.generic");
    expect(classifyRetryError("")).toBe("sessions.retryReason.generic");
  });
});
