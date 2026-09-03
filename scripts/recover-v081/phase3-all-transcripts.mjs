// v0.8.1 代码恢复 · 阶段三：扫描全部会话 transcript，提取所有 Read 过的
// 仓库文件快照。每个文件取「时间最晚」的快照（最接近最终态）。
// transcript 里 model_request.payload.messages 含累积历史：
//   assistant.toolCalls[{id,name:'Read',input:{file_path}}]
//   tool 消息 {toolCallId, content:'cat -n 全文'}
import fs from "node:fs";
import path from "node:path";

const AGENTS_DIR = path.join(
  process.env.USERPROFILE,
  ".zcode",
  "cli",
  "agents"
);
const OUT_DIR = "D:\\MyCodes\\jishu-hub\\scripts\\recover-v081\\snapshot";
const REPO_PREFIX = "D:\\MyCodes\\jishu-hub";

const sessions = fs
  .readdirSync(AGENTS_DIR)
  .filter((d) => d.startsWith("sess_"));

// file_path -> {content, timestamp, source}
const snapshots = new Map();

for (const sess of sessions) {
  const sessDir = path.join(AGENTS_DIR, sess);
  for (const agent of fs.readdirSync(sessDir)) {
    const tf = path.join(sessDir, agent, "transcript.jsonl");
    if (!fs.existsSync(tf)) continue;
    const stat = fs.statSync(tf);
    const lines = fs.readFileSync(tf, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type !== "model_request" || !rec.payload?.messages) continue;
      const ts = rec.timestamp || "";
      const msgs = rec.payload.messages;
      // 收集本条记录内的 Read 调用与结果
      const readByCallId = new Map();
      for (const m of msgs) {
        if (m.role !== "assistant" || !Array.isArray(m.toolCalls)) continue;
        for (const tc of m.toolCalls) {
          if (tc.name === "Read" && tc.input?.file_path && tc.id) {
            readByCallId.set(tc.id, tc.input.file_path);
          }
        }
      }
      if (readByCallId.size === 0) continue;
      for (const m of msgs) {
        if (m.role !== "tool" || !m.toolCallId) continue;
        const fp = readByCallId.get(m.toolCallId);
        if (!fp || m.isError) continue;
        if (!fp.startsWith(REPO_PREFIX)) continue;
        const prev = snapshots.get(fp);
        if (!prev || ts >= prev.timestamp) {
          snapshots.set(fp, {
            content: m.content,
            timestamp: ts,
            source: `${sess}/${agent}`,
          });
        }
      }
    }
  }
}

console.log(`不同文件快照数: ${snapshots.size}`);
// 落盘
const manifest = [];
for (const [fp, snap] of snapshots) {
  const rel = fp
    .slice(REPO_PREFIX.length)
    .replace(/^[\\\/]/, "")
    .replace(/\\/g, "/");
  const stripped = snap.content
    .split("\n")
    .map((l) => l.replace(/^\s*\d+\t(?=.)/, ""))
    .join("\n");
  const outPath = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // 若已有快照且更长，保留更长的（部分读取的片段可能更长？不——时间新的优先但可能片段）
  const exists = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
  if (stripped.split("\n").length >= exists.split("\n").length || !exists) {
    fs.writeFileSync(outPath, stripped);
  }
  manifest.push({
    rel,
    lines: stripped.split("\n").length,
    time: snap.timestamp,
    source: snap.source,
    kept: stripped.split("\n").length >= exists.split("\n").length || !exists,
  });
}
manifest.sort((a, b) => b.time.localeCompare(a.time));
for (const m of manifest) console.log(JSON.stringify(m));
fs.writeFileSync(
  "D:\\MyCodes\\jishu-hub\\scripts\\recover-v081\\snapshot-manifest.json",
  JSON.stringify(manifest, null, 1)
);
