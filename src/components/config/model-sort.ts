// v0.9.2 需求9 补丁九：模型列表排序——按版本号倒序（最新在前）。
// 版本号语义：模型 id 中提取数字序列比较（glm-5.3 > glm-5.2 > glm-5.1；
// gpt-5.6-terra/luna 同版本时按 id 字典序稳定排序；无数字的排最后）。
// 三 agent 共用（ThirdPartyChannelPanel 与 jishu ProviderDetailPanel 同源）。

/** 提取 id 中的数字段（"glm-5.2-flash-250" → [5,2,250]；"gpt-5.6-terra" → [5,6]）。 */
export function versionSegments(id: string): number[] {
  const matches = id.match(/\d+(?:\.\d+)*/g) ?? [];
  return matches.flatMap((m) => m.split(".").map((x) => Number(x)));
}

/** 版本倒序比较器：数字段逐位比较，长者胜；全无数字按字典序，仍倒序。 */
export function byVersionDesc(a: string, b: string): number {
  const va = versionSegments(a);
  const vb = versionSegments(b);
  if (va.length === 0 && vb.length === 0) return b.localeCompare(a);
  if (va.length === 0) return 1;
  if (vb.length === 0) return -1;
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const da = va[i] ?? 0;
    const db = vb[i] ?? 0;
    if (da !== db) return db - da;
  }
  // 版本相同（gpt-5.6-terra vs gpt-5.6-luna）→ id 字典序倒序，稳定。
  return b.localeCompare(a);
}
