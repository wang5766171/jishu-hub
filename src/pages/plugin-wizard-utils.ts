/**
 * 插件创建向导共享工具（v0.9.5 三轮评审 P1-3 修复）。
 *
 * 此前三个创建向导（compose/pipeline/hybrid）各自内联了同款 tomlStr 与
 * slug 生成，存在三个洞（一轮评审 P1-3 + 三轮复核确认）：
 * ① tomlStr 不转义换行——多行提示词生成非法 TOML，保存必报「TOML 解析失败」；
 * ② slug 正则 `[^a-z0-9]+` 不认非 ASCII——纯中文名全部坍缩为同一 id
 *   （session.flow / session.custom / session.hybrid），第二个同名向导静默
 *   覆盖第一个；
 * ③ 保存前不查 id 占用。
 *
 * 修复：tomlStr 改 JSON.stringify（JSON 字符串转义集是 TOML basic string
 * 转义集的子集，控制字符/引号/反斜杠全部合法转义）；slug 改 Unicode 感知
 * （保留 unicode 字母数字——中文名直接进 id，后端 id 仅要求 session. 前缀
 * 无字符集限制，Windows 目录名支持中文）；保存前查占用（重名提示改名，
 * 阻止静默覆盖）。
 */

/**
 * TOML 基本字符串安全序列化：JSON.stringify 的转义输出（\" \\ \n \r \t
 * \uXXXX 等）全部是 TOML basic string 的合法转义序列，可直接内联进 TOML。
 * 换行控制字符经此路径正确转义（修前裸换行导致 TOML 解析失败）。
 */
export function tomlStr(v: string): string {
  return JSON.stringify(v);
}

/**
 * 名称 → 组合插件 id 后缀（Unicode 感知）：保留 unicode 字母/数字（含中文
 * 与全角），其余字符折叠为 `-`。不同中文名产生不同 id——修前 `[^a-z0-9]+`
 * 把纯中文名全部坍缩为 fallback，互相静默覆盖。空名回落 fallback。
 */
export function slugify(name: string, fallback: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

/**
 * 创建前占用检测：id 已被既有组合插件占用时返回 false（调用方提示改名，
 * 阻止静默覆盖——保存按 id 全量替换目录内容）。
 */
export async function composedIdTaken(id: string): Promise<boolean> {
  const { invokeCommand } = await import("@/hooks/use-invoke");
  try {
    const manifests = (await invokeCommand("composed_plugin_manifests")) as Array<{ id?: string }>;
    return Array.isArray(manifests) && manifests.some((m) => m?.id === id);
  } catch {
    // 清单拉取失败（后端异常）：不阻断创建——保存本身有后端校验兜底。
    return false;
  }
}
