const fs = require("fs");
const f = "2026-09-26T05-04-15-147Z_01a0dc19-852b-7310-bd8e-bb219f4ecd1c.jsonl";
const lines = fs.readFileSync(f, "utf-8").trim().split("\n");
console.log("总 entry:", lines.length);
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.includes("dispatch_subagent") && !line.includes("subagent")) continue;
  try {
    const e = JSON.parse(line);
    const role = e.message?.role;
    const content = e.message?.content;
    if (role === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "toolUse" || b.type === "tool_use") {
          console.log("=== tool_use（行", i + 1, "ts", (e.timestamp ?? "").slice(11, 19), "）===");
          console.log(JSON.stringify(b.input ?? b, null, 1).slice(0, 600));
        }
      }
    }
    if (role === "toolResult" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "text") {
          console.log("=== tool_result（行", i + 1, "ts", (e.timestamp ?? "").slice(11, 19), "）===");
          console.log((b.text ?? "").slice(0, 500));
        }
      }
    }
  } catch {}
}
