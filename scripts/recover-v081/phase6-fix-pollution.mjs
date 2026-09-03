// v0.8.1 恢复 · 阶段六：清除快照文件中残留的裸行号行（cat -n 空行残留）。
// 特征：整行恰好是数字且等于该行行号 → 替换为空行。
import fs from "node:fs";
import path from "node:path";

const REPO = "D:\\" + "MyCodes" + "\\" + "jishu-hub";
const report = JSON.parse(
  fs.readFileSync(path.join(REPO, "scripts/recover-v081/apply-report.json"), "utf8")
);

let fixed = 0;
for (const { rel } of report.applied) {
  const p = path.join(REPO, rel);
  if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, "utf8").split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\d{1,5}\t?$/.test(lines[i]) && Number(lines[i].trim()) === i + 1) {
      lines[i] = "";
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(p, lines.join("\n"));
    fixed++;
    console.log("修复: " + rel);
  }
}
console.log("\n共修复 " + fixed + " 个文件");
