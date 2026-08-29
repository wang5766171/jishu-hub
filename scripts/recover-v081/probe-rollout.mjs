// 探查 rollout 中 "name":"Write" 出现的上下文结构
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

// 探查 response 结构中的工具调用
let found = 0;
for (let i = 0; i < lines.length && found < 2; i++) {
  const rec = JSON.parse(lines[i]);
  const resp = rec?.response?.body;
  if (!resp) continue;
  console.log(`=== 记录 ${i} response.body keys:`, Object.keys(resp).join(","));
  const content = resp.content;
  if (Array.isArray(content)) {
    const types = {};
    for (const b of content) types[b.type] = (types[b.type] || 0) + 1;
    console.log("content 块类型:", JSON.stringify(types));
    const tu = content.find((b) => b.type === "tool_use");
    if (tu) {
      console.log("tool_use 样例 keys:", Object.keys(tu).join(","));
      console.log("name:", tu.name, "| input keys:", Object.keys(tu.input || {}).join(","));
    }
  } else if (Array.isArray(resp.choices)) {
    console.log("choices 格式, keys:", Object.keys(resp.choices[0] || {}).join(","));
    const msg = resp.choices[0]?.message || resp.choices[0]?.delta;
    if (msg) {
      console.log("message keys:", Object.keys(msg).join(","));
      if (msg.tool_calls) {
        console.log("tool_calls[0]:", JSON.stringify(msg.tool_calls[0]).slice(0, 300));
      }
    }
  }
  found++;
}
if (!found) console.log("没有 response.body 记录");
