// 全面探查 rollout 记录的字段层级
import fs from "node:fs";
import path from "node:path";

const ROLLOUT = path.join(
  process.env.USERPROFILE,
  ".zcode",
  "cli",
  "rollout",
  "model-io-sess_8f051811-bcb7-4127-9813-38631cf1fd7f.jsonl"
);
const lines = fs.readFileSync(ROLLOUT, "utf8").split("\n").filter(Boolean);

const rec = JSON.parse(lines[0]);
console.log("顶层:", Object.keys(rec).join(","));
console.log("response:", typeof rec.response, rec.response ? Object.keys(rec.response).join(",") : "");
const r = rec.response;
if (r) {
  for (const k of Object.keys(r)) {
    const v = r[k];
    console.log(`  response.${k}:`, typeof v, v && typeof v === "object" ? Object.keys(v).slice(0, 10).join(",") : String(v).slice(0, 60));
  }
}

// 找一条真正含 tool_use 内容的记录（搜 resolve_form 等代码特征）
const kw = "strip_tool_block";
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].includes(kw)) continue;
  const rr = JSON.parse(lines[i]);
  // 递归列出包含大量文本的叶子
  const big = [];
  function walk(o, p) {
    if (big.length >= 5) return;
    if (typeof o === "string" && o.length > 3000 && o.includes(kw)) {
      big.push(`${p} [${o.length}字]`);
      return;
    }
    if (Array.isArray(o)) {
      o.forEach((v, idx) => walk(v, `${p}[${idx}]`));
    } else if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`);
    }
  }
  walk(rr, "$");
  console.log(`\n记录 ${i} 含 "${kw}" 的大文本块:`, JSON.stringify(big, null, 1));
  break;
}
