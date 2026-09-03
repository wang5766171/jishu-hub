// v0.8.1 代码恢复 · 阶段四：将快照应用到工作区。
// 规则：
//   1. 快照行数 >= 现磁盘行数 → 覆盖（快照含 v0.8.1 内容，磁盘是回退的 v0.8.0 或缺失）
//   2. 片段快照（明显短于磁盘现存 v0.8.0 文件的一半）→ 跳过，进 handfix 清单
//   3. 磁盘不存在（新增文件）→ 直接写入
// 输出 apply-report.json 供后续核对。
import fs from "node:fs";
import path from "node:path";

const SNAP = "D:\\MyCodes\\jishu-hub\\scripts\\recover-v081\\snapshot";
const REPO = "D:\\MyCodes\\jishu-hub";
const manifest = JSON.parse(
  fs.readFileSync(
    "D:\\MyCodes\\jishu-hub\\scripts\\recover-v081\\snapshot-manifest.json",
    "utf8"
  )
);

const applied = [];
const skipped = [];
for (const { rel } of manifest) {
  const snapPath = path.join(SNAP, rel);
  const repoPath = path.join(REPO, rel);
  if (!fs.existsSync(snapPath)) continue;
  const snapContent = fs.readFileSync(snapPath, "utf8");
  const snapLines = snapContent.split("\n").length;
  const diskExists = fs.existsSync(repoPath);
  const diskLines = diskExists
    ? fs.readFileSync(repoPath, "utf8").split("\n").length
    : 0;

  if (diskExists && snapLines < diskLines * 0.5) {
    // 明显是片段（Read 带 offset/limit），跳过防降级
    skipped.push({ rel, snapLines, diskLines });
    continue;
  }
  fs.mkdirSync(path.dirname(repoPath), { recursive: true });
  fs.writeFileSync(repoPath, snapContent);
  applied.push({ rel, snapLines, diskLines: diskExists ? diskLines : 0 });
}
console.log(`已应用 ${applied.length} 个文件，跳过片段 ${skipped.length} 个：`);
for (const s of skipped) console.log(`  ✗ ${s.rel} 快照${s.snapLines}行 < 磁盘${s.diskLines}行`);
fs.writeFileSync(
  "D:\\MyCodes\\jishu-hub\\scripts\\recover-v081\\apply-report.json",
  JSON.stringify({ applied, skipped }, null, 1)
);
console.log("\n报告: scripts/recover-v081/apply-report.json");
