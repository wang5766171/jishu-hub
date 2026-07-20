/**
 * jishu agent (pi) 运行所需最低 Node.js 版本。
 *
 * 来源：third_party/pi/package-lock.json 的 engines.node (>=22.19.0)。
 * 升级 pi 时若 engines 变化需手动同步本常量；不接入 upgrade-version.mjs
 * （node engines 变更频率低，且独立于 pi 版本号）。
 */
export const MIN_NODE_VERSION = "22.19.0";

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(v: string): Semver | null {
  const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

/**
 * 比较 semver：负数 a<b，0 相等，正数 a>b；任一无法解析返回 NaN。
 * 兼容带 `v` 前缀（"v22.14.0"）与预发布后缀（"22.14.0-nightly.1" 只取前三段）。
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return NaN;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/**
 * 当前版本是否满足最低要求；无法解析（含 null/空串）时保守返回 false。
 */
export function nodeVersionSatisfies(
  current: string | null,
  minimum: string,
): boolean {
  if (!current) return false;
  const cmp = compareSemver(current, minimum);
  return Number.isNaN(cmp) ? false : cmp >= 0;
}

export function isVersionNewer(current: string, available: string): boolean {
  const cmp = compareSemver(available, current);
  if (Number.isNaN(cmp)) return false;
  if (cmp !== 0) return cmp > 0;

  const revision = (version: string) => {
    const match = version.trim().replace(/^v/, "").match(/^\d+\.\d+\.\d+-(\d+)$/);
    return match ? Number(match[1]) : 0;
  };
  return revision(available) > revision(current);
}
