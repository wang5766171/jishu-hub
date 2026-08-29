// 探查 transcript model_request.messages 的真实块结构
import fs from "node:fs";
import path from "node:path";

const TRANSCRIPT = path.join(
  process.env.USERPROFILE,
  ".zcode",
  "cli",
  "agents",
  "sess_8f051811-bcb7-4127-9813-38631cf1fd7f",
  "agent_b03da8e1-e9c4-4ca4-ab3d-34f5bab84ce9",
  "transcript.jsonl"
);

const lines = fs.readFileSync(TRANSCRIPT, "utf8").split("\n").filter(Boolean);
let latest = null;
for (const line of lines) {
  try {
    const r = JSON.parse(line);
    if (r.type === "model_request" && r.payload?.messages) latest = r;
  } catch {}
}
const msgs = latest.payload.messages;
console.log("messages 数:", msgs.length);

const typeCount = {};
for (const m of msgs) {
  const c = m.content;
  if (typeof c === "string") {
    typeCount["str:" + m.role] = (typeCount["str:" + m.role] || 0) + 1;
    continue;
  }
  if (Array.isArray(c)) {
    for (const b of c) {
      const k =
        m.role +
        ":" +
        (b.type ||
          "keys=" + JSON.stringify(Object.keys(b)).slice(0, 80));
      typeCount[k] = (typeCount[k] || 0) + 1;
    }
  }
}
console.log(JSON.stringify(typeCount, null, 1));

// 各类块的一个样例
const shown = new Set();
for (const m of msgs) {
  if (!Array.isArray(m.content)) continue;
  for (const b of m.content) {
    const key = m.role + ":" + b.type;
    if (!b.type || shown.has(key)) continue;
    shown.add(key);
    console.log(`\n=== 样例 ${key} ===`);
    console.log(JSON.stringify(b).slice(0, 500));
  }
}
