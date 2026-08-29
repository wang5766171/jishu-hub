// v0.8.1 恢复 · 阶段五（止损）：回滚不可信快照覆盖。
// 保留：
//   A. 8/29 审查快照（source 含 b03da8e1）应用的文件——最终态
//   B. git 不跟踪的新增文件（untracked）——磁盘原本没有
// 回滚：其余被中段快照覆盖的 git 跟踪文件 → git checkout 基线
// 子模块单独处理。
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const REPO = "D:\\" + "MyCodes" + "\\" + "jishu-hub";
const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO, "scripts/recover-v081/snapshot-manifest.json"), "utf8")
);
const report = JSON.parse(
  fs.readFileSync(path.join(REPO, "scripts/recover-v081/apply-report.json"), "utf8")
);

// 8/29 审查 subagent 的最终态快照
const trusted = new Set(
  manifest.filter((m) => m.source.includes("b03da8e1")).map((m) => m.rel)
);
console.log("可信快照(8/29):", trusted.size, "个");

// 当前 untracked（新增文件）
const untracked = new Set(
  execSync("git status --porcelain", { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim().replace(/\\/g, "/").replace(/\/$/, ""))
);
console.log("untracked:", untracked.size, "个");

const toRestore = [];
for (const { rel } of report.applied) {
  if (rel.startsWith("third_party/")) continue; // 子模块单独处理
  if (trusted.has(rel)) continue;
  // untracked 匹配（目录级 ?? 前缀也算）
  const isUntracked = [...untracked].some(
    (u) => u === rel || rel.startsWith(u + "/")
  );
  if (isUntracked) continue;
  toRestore.push(rel);
}
console.log("需回滚(git 跟踪且非可信快照):", toRestore.length, "个");
for (const r of toRestore) console.log("  " + r);

let ok = 0;
const failed = [];
for (const r of toRestore) {
  try {
    execSync(`git checkout -- "${r}"`, { cwd: REPO });
    ok++;
  } catch {
    failed.push(r);
  }
}
console.log(`\n主仓回滚成功 ${ok}/${toRestore.length}，失败（保留快照态）:`);
for (const f of failed) console.log("  ! " + f);

// 子模块回滚：除可信快照和新增外全部还原
console.log("\n--- 子模块 third_party/pi ---");
const subApplied = report.applied
  .filter((a) => a.rel.startsWith("third_party/pi/"))
  .map((a) => a.rel);
const subRestore = subApplied.filter(
  (rel) => !trusted.has(rel) && ![...untracked].some((u) => rel.startsWith(u))
);
console.log("子模块应用:", subApplied.length, "回滚:", subRestore.length);
let subOk = 0;
for (const r of subRestore) {
  try {
    execSync(`git checkout -- "${r.slice("third_party/pi/".length)}"`, {
      cwd: path.join(REPO, "third_party", "pi"),
    });
    subOk++;
  } catch {
    console.log("  ! 子模块回滚失败: " + r);
  }
}
console.log(`子模块回滚 ${subOk}/${subRestore.length}`);
console.log("完成");
