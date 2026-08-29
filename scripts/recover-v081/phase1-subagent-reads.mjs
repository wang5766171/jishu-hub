// v0.8.1 代码恢复 · 阶段一（修正版）：从审查 subagent transcript 提取 Read 快照。
// 消息结构：assistant.toolCalls[{id,name:'Read',input:{file_path}}] ↔
//          tool 消息 {toolCallId, content:'cat -n 格式全文'}
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
const OUT_DIR = "D:\\MyCodes\\jishu-hub\\scripts\\recover-v081\\snapshot";
const REPO_PREFIX = "D:\\MyCodes\\jishu-hub";

const lines = fs.readFileSync(TRANSCRIPT, "utf8").split("\n").filter(Boolean);
let latest = null;
for (const line of lines) {
  try {
    const r = JSON.parse(line);
    if (r.type === "model_request" && r.payload?.messages) latest = r;
  } catch {}
}
const msgs = latest.payload.messages;

// 1) 收集 Read toolCallId -> file_path
const readByCallId = new Map();
for (const m of msgs) {
  if (m.role !== "assistant" || !Array.isArray(m.toolCalls)) continue;
  for (const tc of m.toolCalls) {
    if (tc.name === "Read" && tc.input?.file_path && tc.id) {
      readByCallId.set(tc.id, tc.input.file_path);
    }
  }
}
console.log("Read 调用数:", readByCallId.size);

// 2) 匹配 tool 结果（同文件多次读，取最后一次）
const lastResult = new Map(); // file_path -> content
for (const m of msgs) {
  if (m.role !== "tool" || !m.toolCallId) continue;
  const fp = readByCallId.get(m.toolCallId);
  if (!fp || m.isError) continue;
  lastResult.set(fp, m.content);
}

// 3) 剥离 cat -n 行号并落盘
fs.mkdirSync(OUT_DIR, { recursive: true });
const written = [];
for (const [fp, text] of lastResult) {
  if (!fp.startsWith(REPO_PREFIX)) continue;
  const rel = fp
    .slice(REPO_PREFIX.length)
    .replace(/^[\\\/]/, "")
    .replace(/\\/g, "/");
  const stripped = text
    .split("\n")
    .map((l) => l.replace(/^\s*\d+\t(?=.)/, ""))
    .join("\n");
  const outPath = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stripped);
  written.push(`${rel} — ${stripped.split("\n").length} 行`);
}
console.log(`\n恢复快照 ${written.length} 个文件:`);
for (const w of written) console.log("  " + w);
