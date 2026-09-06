/** v0.9.1 需求14 测试期补充：自动重试失败原因分类（用户裁决——横幅前缀
 * 友好分类如「网络无法连接，第 x/10 次自动重试中」，原始报错降级为悬停
 * 提示）。按常见瞬时性错误特征归类，返回 i18n key；未命中回通用档。
 * 纯函数可单测；大小写不敏感，兼容中英文报错片段。 */
export function classifyRetryError(raw: string): string {
  const s = raw.toLowerCase();
  if (/econnrefused|connect refused|connection refused|无法连接/.test(s)) {
    return "sessions.retryReasonNetwork";
  }
  if (/enotfound|getaddrinfo|dns|域名解析/.test(s)) {
    return "sessions.retryReasonDns";
  }
  if (/etimedout|timeout|timed out|超时/.test(s)) {
    return "sessions.retryReasonTimeout";
  }
  if (/econnreset|socket hang up|connection reset|连接中断|aborted/.test(s)) {
    return "sessions.retryReasonReset";
  }
  if (/\b429\b|rate limit|too many requests|请求过于频繁/.test(s)) {
    return "sessions.retryReasonRateLimit";
  }
  if (/\b5\d\d\b|service unavailable|bad gateway|overloaded|internal server|服务不可用/.test(s)) {
    return "sessions.retryReasonServer";
  }
  if (/\b401\b|\b403\b|unauthorized|forbidden|api key|认证/.test(s)) {
    return "sessions.retryReasonAuth";
  }
  return "sessions.retryReasonGeneric";
}
