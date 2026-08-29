// 探查 str:tool / str:assistant 消息内容格式
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

let toolShown = 0;
let asstShown = 0;
for (const m of msgs) {
  if (typeof m.content !== "string") continue;
  if (m.role === "tool" && toolShown < 3) {
    toolShown++;
    console.log(
      `=== tool 消息 ${toolShown} (meta keys: ${Object.keys(m).join(",")}) ===`
    );
    console.log("content 前 300 字:", m.content.slice(0, 300));
    if (m.toolCallId || m.tool_call_id)
      console.log("toolCallId:", m.toolCallId || m.tool_call_id);
    console.log();
  }
  if (m.role === "assistant" && asstShown < 2) {
    asstShown++;
    console.log(
      `=== assistant str 消息 ${asstShown} (meta keys: ${Object.keys(m).join(",")}) ===`
    );
    console.log("content 前 600 字:", m.content.slice(0, 600));
    console.log();
  }
}
