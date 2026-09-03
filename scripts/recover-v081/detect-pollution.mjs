// 检测双层行号污染（快照内容本身带 cat -n 行号，剥离一层后仍剩一层）
import fs from "node:fs";
import path from "node:path";

const REPO = "D:\\" + "MyCodes" + "\\" + "jishu-hub";
const dirs = [
  path.join(REPO, "src-tauri", "src"),
  path.join(REPO, "src"),
  path.join(REPO, "src-tauri", "resources"),
];
const polluted = [];
const walk = (d) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(rs|tsx?|toml|json|md)$/.test(f)) continue;
    const lines = fs.readFileSync(p, "utf8").split("\n");
    let hits = 0;
    for (let i = 0; i < Math.min(50, lines.length); i++) {
      const m = lines[i].match(/^(\d{1,4})\s/);
      if (m && Number(m[1]) === i + 1) hits++;
    }
    if (hits >= 40) polluted.push(path.relative(REPO, p) + ` ${hits}/50`);
  }
};
for (const d of dirs) if (fs.existsSync(d)) walk(d);
console.log(polluted.length ? polluted.join("\n") : "无污染");
