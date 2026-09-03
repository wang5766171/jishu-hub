// v0.8.1 代码恢复 · 阶段二：从主会话 rollout 提取全部 Write/Edit 工具调用。
// rollout 每条记录的 request.body.messages 是累积历史，用 toolCallId 去重保序。
import fs from "node:fs";
import path from "node:path";

const ROLLOUT = path.join(
  process.env.USERPROFILE,
  ".zcode",
  "cli",
  "rollout",
  "model-io-sess_8f051811-bcb7-4127-9813-38631cf1fd7f.jsonl"
);
const OUT = "D:\\MyCodes\\jishu-hub\\scripts\\recover-v081\\ops.json";
const REPO_PREFIX = "D:\\MyCodes\\jishu-hub";

const lines = fs.readFileSync(ROLLOUT, "utf8").split("\n").filter(Boolean);
console.log("rollout 记录数:", lines.length);

const seen = new Set(); // toolCallId 去重
const ops = []; // {id, name, input} 按首次出现顺序

for (const line of lines) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }
  // 响应中的调用（rollout 真实结构：response.toolCalls 数组）
  const tcs = rec?.response?.toolCalls;
  if (Array.isArray(tcs)) {
    for (const tc of tcs) {
      if (!tc.id || seen.has(tc.id)) continue;
      if (tc.name !== "Write" && tc.name !== "Edit") continue;
      seen.add(tc.id);
      ops.push({ id: tc.id, name: tc.name, input: tc.input });
    }
  }
  // 请求历史中的调用（request.messages[].toolCalls）
  const messages = rec?.request?.messages;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!Array.isArray(m.toolCalls)) continue;
      for (const tc of m.toolCalls) {
        if (!tc.id || seen.has(tc.id)) continue;
        if (tc.name !== "Write" && tc.name !== "Edit") continue;
        seen.add(tc.id);
        ops.push({ id: tc.id, name: tc.name, input: tc.input });
      }
    }
  }
}

console.log(`去重后 Write/Edit 调用: ${ops.length}`);
const byName = {};
for (const o of ops) byName[o.name] = (byName[o.name] || 0) + 1;
console.log(JSON.stringify(byName));

// 涉及的文件清单
const files = {};
for (const o of ops) {
  const fp = o.input?.file_path || "?";
  if (!fp.startsWith(REPO_PREFIX)) {
    files["<仓库外>"] = (files["<仓库外>"] || 0) + 1;
    continue;
  }
  const rel = fp
    .slice(REPO_PREFIX.length)
    .replace(/^[\\\/]/, "")
    .replace(/\\/g, "/");
  files[rel] = (files[rel] || 0) + 1;
}
console.log("\n涉及文件（调用次数）:");
for (const [f, n] of Object.entries(files).sort()) console.log(`  ${f} — ${n}`);

fs.writeFileSync(OUT, JSON.stringify(ops));
console.log("\n已写出:", OUT);
