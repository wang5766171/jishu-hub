#!/usr/bin/env node
/**
 * run.mjs —— jishu-hub 自动化测试运行入口（v0.9.8 需求20）
 *
 * 用法（仓库根目录）：
 *   node scripts/e2e/run.mjs --suite smoke                  基础冒烟（不需要模型与网络）
 *   node scripts/e2e/run.mjs --suite conversation           对话（需要可用模型；会新建测试会话）
 *   node scripts/e2e/run.mjs --suite market                 市场安装（需要联网；装一个扩展并卸载）
 *   node scripts/e2e/run.mjs --suite fixround               评审修复轮（需要模型；F7 另需联网，真装冲突扩展选「停用并安装」）
 *   node scripts/e2e/run.mjs --suite compact                斜杠命令与上下文压缩（需要模型；会往测试会话发很长的消息）
 *   node scripts/e2e/run.mjs --suite search                 搜索体验与工具标签（SE-1~SE-3、SE-7、SE-8、SE-11、SE-13、SE-15 不需要模型；其余需要可用模型）
 *   node scripts/e2e/run.mjs --suite unread                 未读标记（需要模型；发一条慢消息并在回合结束前切走）
 *   node scripts/e2e/run.mjs --suite tasksession            任务会话：滚动位置（需要模型；TS-1、TS-3 会重载页面；TS-4 切节点停用——带图任务暂无真实创建路径，待建图恢复）
 *   node scripts/e2e/run.mjs --suite approval               工具执行审批：同意 / 不同意 / 默认不表态（需要模型；会切访问权限档位，用例内还原）
 *   node scripts/e2e/run.mjs --suite full                   全量
 *   可选：--project <项目名>   在指定项目里跑（默认：应用当前所在项目）
 *         --out <目录>        结果输出目录（默认 scripts/e2e/results/<时间戳>/，已 gitignore；已存在会告警）
 *         --only I1,I3        只跑指定编号（还原类用例始终执行）
 *         --list              列出场景包里的用例
 *         --checklist         输出四字段用例清单（markdown，可直接落 06-测试清单.md）
 *         --no-lang-switch    界面不是中文时不自动切换（默认：临时切中文，结束后还原并读回）
 *
 * 退出码：0 = 全部通过（跳过不算失败）；1 = 有失败（含还原没做成、界面语言没还原）；2 = 无法运行（未附着 /
 * 前置不满足）；130 = 用户中断。
 * 产物：<out>/result.json、<out>/test-log.md、<out>/screenshots/*.png
 *
 * 用例超时与用户中断（v0.9.8 评审修复轮 R2）：
 * - 超时后原用例被「终止」：它拿到的是一条专用的驱动视图（lib-pw 的 forCase）——超时那一刻起，它再调任何
 *   驱动方法都立即抛错，正在进行的轮询等待下一轮就退出，不会带着界面操作活到下一条用例、并发地改界面；
 * - 块上登记的 restore（如审批用例的「切回原档」）无论成败、超时、中断都会执行；
 * - Ctrl+C：不再开始新用例，当前用例立刻收场，还原类（cleanup: true）执行完再退出；再按一次立即退出。
 *
 * 约定：积木（blocks/）里不写死任何机器信息——项目名、会话标题、已装扩展都运行时探测。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUITES } from "./suites.mjs";
import { Skip, ensureDemoPng } from "./kit.mjs";
import { open, expect, readSessionUsers } from "./lib-pw.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const k = a.slice(2);
        const nxt = argv[i + 1];
        if (nxt !== undefined && !nxt.startsWith("--")) {
          out[k] = nxt;
          i++;
        } else out[k] = true;
      }
    } else out._.push(a);
  }
  return out;
}

const USAGE = `用法：node scripts/e2e/run.mjs --suite <${Object.keys(SUITES).join("|")}> [--project 名] [--out 目录] [--only I1,I3]
       node scripts/e2e/run.mjs --suite <名> --list        列出用例
       node scripts/e2e/run.mjs --suite <名> --checklist   输出四字段用例清单（markdown）
场景包：${Object.entries(SUITES)
  .map(([k, v]) => `\n  ${k.padEnd(13)} ${v.name}——${v.desc}`)
  .join("")}`;

const NEEDS_TEXT = { none: "无", model: "可用模型", network: "联网" };
/**
 * 各场景包写进 test-log.md「副作用」一节的提示（模型用量、留在项目里的东西、动过的设置）。
 * 判断一律用场景包的键名——曾经拿中文译名去比，条件恒假，提示一次都没写进去过（评审修复轮 R2）。
 */
const SUITE_NOTES = {
  fixround: [
    "F7 会真装一个冲突扩展并选「停用并安装」（临时停用与它撞名的已装扩展）；用例内卸载即自动恢复，登记簿若仍有冲突停用记录说明还原未完",
  ],
  compact: [
    "本场景包向每个测试会话发送两条各约 9 万字符的「接口清单」消息（让会话大到可压缩），**占用模型用量**；这些会话留在当前项目里，标题较长",
    "EC-10、EC-11 另各发一条要写长篇故事的慢消息（回合要跑到结束，排队的压缩才执行）",
  ],
  search: [
    "需要模型的用例新建两个测试会话：一个连发四条短消息，一个（SE-14 工具标签）发一条带工具标签的消息（各占用少量模型用量），留在当前项目里",
    "SE-14 会重载应用页面回到它自己那个会话（有会话的回合在跑时不重载）；SE-15 会打开侧栏搜「@[」命中的最多 5 个已有会话（清掉它们的未读标记）",
  ],
  unread: [
    "每次运行新建一个对话，并往项目里已有的一个任务会话里发一条慢消息（占用少量模型用量）；项目里没有任务会话时会造一个带任务图的任务（主会话只回复文字、节点不调用工具）——都留在当前项目里",
    "UN-1 第一步会把任务列表里已有的绿点清掉（产品的「查看即已读」行为）",
  ],
  tasksession: [
    "可能往项目里已有的一个任务会话发一条「数到 600」的消息（TS-3 每次都发；TS-1 量不出位置时也发），占用少量模型用量；项目里一个任务都没有时另造一个带任务图的任务（节点不调用工具）——都留在当前项目里",
    "TS-4 每次运行新建一个对话、一张任务图、一个带任务图的任务和两个节点子会话，留在当前项目里",
    "TS-1、TS-3 会重载应用页面（造「启动后第一次进入」的状态；引擎进程不重启）；TS-5、TS-6 会打开项目里消息最多的几个会话（清掉它们的未读标记）",
  ],
  approval: [
    "**会切换「访问权限」档位**：切到「变更前审批」（没有这一档时退到「智能审批」）做验证；用例内 try/finally 切回原档、还原用例 APX-1 兜底，切回后读回档位与触发钮文案核对",
    "切档是产品行为：会重启该智能体全部会话的引擎进程（有回合在跑时用例跳过，不去打断用户的回合）",
    "运行前从未设置过档位时，切回后后端会留下显式的「完全访问」——行为相同（都不弹审批），产品没有清除选择的入口；日志的「访问权限档位」一行会如实写出",
    "每次运行新建三个对话，各让模型执行一条 echo 命令（占用少量模型用量），留在当前项目里",
  ],
};
const stampOf = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(
    d.getMinutes(),
  ).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

function selectedCases(suite, only) {
  let cases = suite.cases;
  if (only) {
    const ids = String(only)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const picked = cases.filter((c) => ids.includes(c.id));
    const missing = ids.filter((id) => !picked.some((c) => c.id === id));
    if (missing.length) console.error(`未找到用例：${missing.join(", ")}`);
    cases = picked;
  }
  // 还原类用例始终保留（否则 --only P1 装上的扩展没人卸）
  for (const c of suite.cases) if (c.cleanup && !cases.includes(c)) cases.push(c);
  return cases;
}

function printList(name, suite, cases) {
  console.log(`场景包 ${name}（${suite.desc}）`);
  for (const c of cases) console.log(`  ${c.id.padEnd(5)} ${c.name}   [依赖：${NEEDS_TEXT[c.needs] || c.needs}]${c.cleanup ? "  [还原]" : ""}`);
}

function printChecklist(name, suite, cases) {
  console.log(`# ${name} 场景包用例清单（${suite.desc}）\n`);
  console.log(`> 由 \`node scripts/e2e/run.mjs --suite ${name} --checklist\` 生成；执行后结果见同目录 test-log.md。\n`);
  console.log("| 编号 | 用例名称 | 涉及功能 | 操作步骤 | 通过条件 | 依赖 | 结果 |");
  console.log("|---|---|---|---|---|---|---|");
  for (const c of cases) {
    const cell = (s) => String(s).replace(/\|/g, "／");
    console.log(`| ${c.id} | ${cell(c.name)} | ${cell(c.feature)} | ${cell(c.steps)} | ${cell(c.expect)} | ${NEEDS_TEXT[c.needs] || c.needs} | ☐ |`);
  }
}

function renderLog(meta, results, { state, approvalLog }) {
  const cell = (s) => String(s ?? "").replace(/\|/g, "／").replace(/\n+/g, " ");
  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.ok && r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;
  const lines = [];
  lines.push(`# e2e 测试日志（${meta.suiteName} 场景包）\n`);
  lines.push(`- 运行时间：${meta.time}`);
  lines.push(`- 场景包：${meta.suiteName}——${meta.suiteDesc}`);
  lines.push(`- 项目：${meta.project || "(未知)"}`);
  lines.push(`- 应用页面：${meta.pageUrl}｜平台：${meta.platform}｜Node ${meta.node}｜Playwright ${meta.playwright}`);
  if (meta.outExisted) lines.push(`- ⚠ 输出目录在运行前就已存在（${meta.out}）：同名文件被本轮覆盖，目录里可能留着以前的结果文件`);
  lines.push(`- 结果：**通过 ${passed} · 跳过 ${skipped} · 失败 ${failed}**${meta.interrupted ? "（用户中断，后面没有跑完）" : ""}\n`);
  lines.push("| 编号 | 用例 | 依赖 | 结果 | 耗时 | 关键事实 / 原因 |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of results) {
    const partial = r.ok && !r.skipped && r.warnings?.length;
    const verdict = !r.ok ? "❌ 失败" : r.skipped ? "⏭ 跳过" : partial ? "✅ 通过（有未核对的断言）" : "✅ 通过";
    const notes = [
      ...(r.warnings || []).map((w) => `⚠ 未核对：${w}`),
      r.restored?.运行前 ? `已切回原档「${r.restored.还原后.档位}」` : "",
      r.restored?.还原 ? `还原：${r.restored.还原}` : "",
    ].filter(Boolean);
    const body = !r.ok
      ? [r.error, r.restoreError ? `还原失败：${r.restoreError}` : ""].filter(Boolean).join("｜")
      : r.skipped
        ? r.skipped
        : JSON.stringify(r.facts ?? null);
    lines.push(`| ${r.id} | ${cell(r.name)} | ${NEEDS_TEXT[r.needs] || r.needs} | ${verdict} | ${r.ms}ms | ${cell([...notes, body].join("｜")).slice(0, 700)} |`);
  }
  const se = meta.sideEffects;
  lines.push(`\n## 副作用\n`);
  lines.push(`- 新建测试会话：${se.sessionsCreated} 个（留在当前项目，未删除）`);
  const clip = se.clipboard.length ? se.clipboard.map((c) => (c.clipboardRestored ? "已还原（读回一致）" : "未还原")).join("，") : "未占用";
  lines.push(`- 系统剪贴板：${clip}`);
  if (se.clipboardUntouched.length) lines.push(`- 系统剪贴板没有被占用（里面是图片 / 文件 / 别的内容，或读不出来）：${se.clipboardUntouched.join("；")}`);
  if (se.clipboardFallback) lines.push(`- ⚠ 有 ${se.clipboardFallback} 个附件用例没走成「系统剪贴板 + Ctrl+V」，回落到了合成粘贴事件（事件不是可信事件，但走应用同一条粘贴处理链）${se.clipboardFallbackReasons.length ? `；原因：${se.clipboardFallbackReasons.join("；")}` : ""}`);
  lines.push(`- 测试安装的扩展：${se.installedTotal ? `${se.installedTotal} 个，${se.installedLeft ? "有残留（按「当前已装源 − 运行前基线」实测，见还原用例）" : "已全部卸载（按「当前已装源 − 运行前基线」实测）"}` : "无"}`);
  if (se.curatedInstalledLeft) lines.push(`- ⚠ 本轮装卸的精选件与运行前不一致（实测差 ${se.curatedInstalledLeft} 件，见还原用例 FX2）`);
  for (const note of SUITE_NOTES[meta.suiteName] || []) lines.push(`- ${note}`);
  // 审批：自动化对审批卡的每一次表态都要留痕（评审修复轮 R2 / 裁决 9：默认不替用户放行）
  const acts = approvalLog || [];
  if (acts.length) {
    const count = (re) => acts.filter((a) => re.test(a.button)).length;
    lines.push(
      `- 审批操作：自动化对审批卡表态 ${acts.length} 次——「仅本次允许」${count(/^仅本次允许$/)} 次、「拒绝」${count(/^拒绝$/)} 次、按 Esc 拒绝 ${count(/Esc/)} 次（「始终允许」0 次）`,
    );
    for (const a of acts) {
      lines.push(`  - ${a.by}：${a.button}｜工具 ${a.tool ?? "?"}｜${String(a.summary ?? "").slice(0, 80)}${a.settled === false ? "｜卡没有收起" : ""}`);
    }
  } else lines.push("- 审批操作：无（本轮没有遇到审批卡）");
  if (se.approvalsClearedAfterCase) lines.push(`- ⚠ 有 ${se.approvalsClearedAfterCase} 张审批卡是用例结束后还留在屏幕上、被运行器按 Esc 拒绝的（见运行日志里带「[审批卡]」的行）`);
  // 访问权限档位：切过就必须切回并读回（approval 场景包、冒烟的 C4c）
  const reports = state.accessRestoreReports || [];
  if (reports.length) {
    lines.push(`- 访问权限档位：切过 ${reports.length} 次，都已切回运行前的那一档并读回核对（${reports.map((r) => `${r.还原后.档位}`).join("、")}）`);
    const diffs = reports.filter((r) => !/^无/.test(r.存储差异));
    if (diffs.length) lines.push(`  - ⚠ 其中 ${diffs.length} 次切回后后端留下显式档位（运行前从未设置过）：${diffs.map((r) => r.存储差异).join("；")}`);
  }
  if (state.accessRestore) lines.push(`- ⚠ 访问权限档位没有还原：运行前是「${state.accessRestore.fromLabel}」，现在不是——请手动切回`);
  lines.push(`- 界面语言：${se.langRestored ? "临时切换后已还原（读回一致）" : meta.langSwitched ? "⚠ 临时切换后**没有还原**（读回与运行前不一致）" : "未改动"}`);
  lines.push(`- 其它：切会话/切项目会清对应会话或项目的未读标记（产品行为：查看即已读）`);
  return lines.join("\n") + "\n";
}

/** 用户中断（Ctrl+C）：让当前用例立刻收场。 */
class Interrupt extends Error {}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(USAGE);
    return 0;
  }
  const suiteName = String(args.suite || "smoke");
  const suite = SUITES[suiteName];
  if (!suite) {
    console.error(`未知场景包「${suiteName}」。\n${USAGE}`);
    return 2;
  }
  const cases = selectedCases(suite, args.only);
  if (!cases.length) return 2;
  if (args.list) {
    printList(suiteName, suite, cases);
    return 0;
  }
  if (args.checklist) {
    printChecklist(suiteName, suite, cases);
    return 0;
  }

  const startedAt = Date.now();
  const out = path.resolve(String(args.out || path.join(ROOT, "scripts", "e2e", "results", stampOf(new Date()))));
  const outExisted = fs.existsSync(out);
  fs.mkdirSync(path.join(out, "screenshots"), { recursive: true });
  const logLines = [];
  const log = (m = "") => {
    logLines.push(String(m));
    console.log(m);
  };
  log(`场景包：${suiteName}（${suite.desc}）｜输出：${out}`);
  if (outExisted) {
    const old = fs.readdirSync(out).filter((n) => n !== "screenshots").length;
    log(`⚠ 输出目录在运行前就已存在：同名文件（result.json、test-log.md、同名截图）会被本轮覆盖${old ? `，目录里还留着 ${old} 项以前的结果` : ""}——要把这一轮单独留痕，请换一个目录`);
  }

  let app;
  try {
    app = await open({ log });
  } catch (e) {
    console.error(`无法附着应用（${e.message}）。\n先启动带调试口的应用：node scripts/e2e/start.mjs`);
    return 2;
  }
  const page = app.page;

  const state = {
    installed: [],
    installedLog: [],
    curatedTarget: {}, // 评审修复轮 F6 动过的精选件：id → 目标安装态（还原用例 FX2 按此调回）
    curatedBaseline: null, // 运行前已装的本地精选件（实测快照）——FX2 在目标态表为空时也按它核对
    accessRestore: null, // approval：切过访问权限档位时记着运行前的档位（用例内还原 + APX-1 兜底）
    accessRestoreReports: [], // 每一次切回原档的读回结果（写进报告）
    modelOk: null,
    baselineSources: [],
    sessionsCreated: 0,
    clipboard: [],
    clipboardUntouched: [], // 没有占用系统剪贴板的附件用例及原因
    clipboardFallbackReasons: [],
  };
  const ctx = {
    app,
    page,
    expect,
    state,
    cfg: { suite: suiteName, out, project: null },
    shot: async (name) => app.shot(path.join(out, "screenshots", `${name}.png`)),
    fixture: (name) => ensureDemoPng(path.join(out, "fixtures", name)), // 演示图运行时现画（仓库忽略全部 png，不入库）
    // 会话落盘真值；needles 是要在整段文字里找的词（返回值里的 found）
    truth: async (sinceMs, needles = []) => {
      const h = await app.sessionHeader();
      return h ? readSessionUsers(h.id, sinceMs, needles) : null;
    },
    skip(reason) {
      throw new Skip(reason);
    },
    since: startedAt,
  };

  const results = [];
  const meta = { suiteName, suiteDesc: suite.desc, time: new Date(startedAt).toLocaleString("zh-CN", { hour12: false }), out, outExisted };
  const sideEffects = {
    sessionsCreated: 0,
    clipboard: [],
    clipboardUntouched: [],
    installedTotal: 0,
    installedLeft: 0,
    langRestored: false,
  };
  let exitCode = 0;
  let langSwitched = false;
  let langBefore = null;

  // Ctrl+C：不再开始新用例；当前用例立刻以「用户中断」收场（还原类照常执行完）；再按一次立即退出
  let interrupted = false;
  let abortCurrent = null;
  const onSigint = () => {
    if (interrupted) {
      console.error("\n再次收到中断：立即退出（还原用例可能没有执行完，请核对本轮动过的设置）。");
      process.exit(130);
    }
    interrupted = true;
    console.error("\n收到中断：不再开始新的用例，执行还原后退出（再按一次 Ctrl+C 立即退出）。");
    if (abortCurrent) abortCurrent(new Interrupt("用户中断"));
  };
  process.on("SIGINT", onSigint);

  const runCase = async (c) => {
    log(`\n▶ ${c.id} ${c.name}`);
    const t0 = Date.now();
    const limit = Number(c.timeoutMs || 240000);
    const row = { id: c.id, name: c.name, needs: c.needs, cleanup: !!c.cleanup };
    let timer;
    // 这条用例专用的驱动视图：超时 / 中断后 expire()——它后面的每一步驱动调用都立即抛错，
    // 正在进行的轮询等待下一轮就退出（见 lib-pw 的 forCase）
    const lease = app.forCase();
    const guarded = (fn) => (...args) => {
      if (!lease.alive()) throw new Error("用例已超时，后续操作不再执行");
      return fn(...args);
    };
    const warnings = [];
    const caseCtx = { ...ctx, app: lease.app, shot: guarded(ctx.shot), fixture: guarded(ctx.fixture), truth: guarded(ctx.truth), warn: (m) => warnings.push(String(m)) };
    // 超时后原用例的异步还在跑：它的后续报错必须有人接，否则未处理的 rejection 会让进程退出
    let abort;
    const aborted = new Promise((_, reject) => (abort = reject));
    aborted.catch(() => {});
    abortCurrent = abort;
    const task = Promise.resolve().then(() => c.run(caseCtx));
    task.catch(() => {});
    let timedOut = false;
    try {
      row.facts = await Promise.race([
        task,
        new Promise((_, rej) => {
          timer = setTimeout(() => {
            timedOut = true;
            rej(new Error(`用例超时（${limit}ms）`));
          }, limit);
        }),
        aborted,
      ]);
      row.ok = true;
    } catch (e) {
      if (e instanceof Skip) {
        row.ok = true;
        row.skipped = e.message;
      } else if (e instanceof Interrupt) {
        // 用户中断：这条用例不算失败，如实标「没有跑完」；下面的还原动作照常执行
        lease.expire();
        await Promise.race([task.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 15000))]);
        row.ok = true;
        row.skipped = "用户中断，用例没有跑完";
      } else {
        row.ok = false;
        row.error = String(e?.message || e).slice(0, 1800);
        if (timedOut) {
          // 终止它：之后它的每一步驱动调用都会被挡下；给它 15 秒把手里的事做完（通常下一轮就退出）
          lease.expire();
          const settled = await Promise.race([task.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 15000))]);
          row.error += settled ? "｜原用例已终止" : "｜原用例 15 秒内没有停手（它后续的每一步驱动调用都会被挡下）";
        }
        // 失败现场：一张截图 + 一行界面状态——事后复现往往复现不出来，现场只有这一次
        try {
          await app.shot(path.join(out, "screenshots", `${c.id}-失败现场.png`));
          row.scene = await page.evaluate(() => {
            const ta = [...document.querySelectorAll("textarea")].find((t) => t.getBoundingClientRect().height > 0);
            const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((d) => d.getBoundingClientRect().height > 0);
            return {
              输入框可用: ta ? !ta.disabled && !ta.readOnly : null,
              输入框内容: ta ? ta.value.slice(0, 30) : null,
              停止钮: !!document.querySelector('button[title="停止"]:not([disabled])'),
              开着的弹层数: dialogs.length,
              开着的弹层: dialogs.map((d) => (d.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40)),
              在管理页: !!document.querySelector('button[title="返回工作区"]') || (document.body.textContent || "").includes("返回工作区"),
            };
          }).catch(() => null);
          log(`  失败现场：${path.join("screenshots", `${c.id}-失败现场.png`)}｜${JSON.stringify(row.scene)}`);
        } catch {
          /* 现场留存失败不影响失败结论 */
        }
      }
    } finally {
      clearTimeout(timer);
      abortCurrent = null;
      lease.expire(); // 用例跑完了也一样：它留下的任何异步都不许再碰界面
    }
    if (warnings.length) row.warnings = warnings;
    row.ms = Date.now() - t0;
    // 用例自己登记的还原动作：成败、超时、中断都执行——用真正的驱动，不受上面的租约限制
    if (c.restore) {
      try {
        row.restored = await c.restore(ctx);
      } catch (e) {
        row.ok = false;
        row.restoreError = String(e?.message || e).slice(0, 1800);
      }
    }
    return row;
  };

  // 「已进入主界面」= 会话工作区或管理页任一可见（上一轮测试可能把应用停在管理页）
  const mainUi = page.locator(".chat-sidebar").or(page.getByRole("button", { name: "返回工作区", exact: true })).first();
  const waitMainUi = (timeout) => mainUi.waitFor({ state: "visible", timeout }).then(() => true, () => false);

  try {
    if (!(await waitMainUi(15000))) throw new Error("应用未进入主界面（首次引导未完成，或停在错误页）");
    if (!(await app.isChineseUI())) {
      if (args["no-lang-switch"]) {
        throw new Error("当前界面不是中文——积木按中文界面定位。去掉 --no-lang-switch 可让运行器临时切到中文并在结束后还原");
      }
      langBefore = await page.evaluate(() => localStorage.getItem("jishu-hub-lang"));
      await page.evaluate(() => {
        localStorage.setItem("jishu-hub-lang", "zh");
        location.reload();
      });
      await waitMainUi(20000);
      await page.waitForTimeout(1500);
      langSwitched = true;
      log("界面语言已临时切到中文（运行结束后还原并读回核对）");
    }
    await app.ensureWorkspace();
    await app.closeGuideCards();
    const project = args.project ? await app.ensureWorkspace(String(args.project)) : await app.currentProjectName();
    ctx.cfg.project = project;
    meta.project = project;
    meta.pageUrl = page.url();
    meta.platform = `${process.platform} ${process.arch}`;
    meta.node = process.version;
    meta.playwright = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "playwright", "package.json"), "utf8")).version;
    state.baselineSources = await app.invoke("pi_package_installed_sources").catch(() => []);
    // 精选件里「本地件」的已装清单（装/卸只是写/删一个清单文件，可逆）——FX2 在目标态表为空时也按它核对
    try {
      const curated = await app.invoke("market_list_curated");
      const installed = await app.invoke("plugin_list");
      const localIds = new Set((Array.isArray(curated) ? curated : []).filter((e) => e?.kind === "agent").map((e) => e.id));
      state.curatedBaseline = ((installed && installed.plugins) || []).map((p) => p.id).filter((id) => localIds.has(id));
    } catch {
      state.curatedBaseline = null; // 取不到基线：FX2 如实说明没法核对
    }
    log(`项目：${project || "(未识别)"}｜已装扩展基线：${state.baselineSources.length} 个｜已装本地精选件基线：${state.curatedBaseline ? `${state.curatedBaseline.length} 个` : "没取到"}`);

    const ordered = [...cases.filter((c) => !c.cleanup), ...cases.filter((c) => c.cleanup)];
    for (const c of ordered) {
      if (interrupted && !c.cleanup) {
        results.push({ id: c.id, name: c.name, needs: c.needs, ok: true, skipped: "用户中断，没有执行", ms: 0 });
        continue;
      }
      const row = await runCase(c);
      results.push(row);
      if (!row.ok) exitCode = 1;
      const partial = row.ok && !row.skipped && row.warnings?.length;
      const verdict = !row.ok ? "❌ 失败" : row.skipped ? "⏭ 跳过" : partial ? "✅ 通过（有未核对的断言）" : "✅ 通过";
      const note = !row.ok ? [row.error, row.restoreError ? `还原失败：${row.restoreError}` : ""].join("｜") : row.skipped ? row.skipped : "";
      log(`  ${verdict}  ${row.ms}ms${note ? " ｜ " + String(note).slice(0, 300) : ""}`);
      for (const w of row.warnings || []) log(`  ⚠ 未核对：${w}`);
      if (row.restored?.运行前) log(`  已切回原档「${row.restored.还原后.档位}」（${row.restored.存储差异}）`);
      // 现场复位：失败的用例常把弹层、输入框里的半截内容留在屏幕上，下个用例一开头就落空
      const closed = await app.cancelResidualDialog().catch(() => null);
      if (String(closed || "").startsWith("[审批卡]")) {
        sideEffects.approvalsClearedAfterCase = (sideEffects.approvalsClearedAfterCase || 0) + 1;
        log(`  ⚠ 用例结束后屏幕上还留着审批卡，已按 Esc 拒绝：${closed}`);
      }
      const leftover = await app.clearComposerLeftover().catch(() => "");
      if (leftover) log(`  （已清掉上一用例留在输入框的内容：${leftover.slice(0, 40)}）`);
    }
    // 用例动过的设置没能还原（切走的访问权限档位还挂着）：这一轮不能算绿
    if (state.accessRestore) {
      log(`⚠ 访问权限档位没有还原：运行前是「${state.accessRestore.fromLabel}」——请手动切回`);
      exitCode = exitCode || 1;
    }
  } catch (e) {
    log(`运行中止：${e?.message || e}`);
    exitCode = 2;
  } finally {
    // Ctrl+C 的处理器留到最后（process.exit 收尾）：还原、写结果期间再按一次才会立即退出
    // 残留按实测，不按台账：超时后才装上的扩展不会进台账，但会在已装源里
    try {
      const sources = await app.invoke("pi_package_installed_sources").catch(() => null);
      if (Array.isArray(sources)) sideEffects.installedLeft = sources.filter((s) => !state.baselineSources.includes(s)).length;
    } catch {
      /* 读不到就沿用台账口径 */
    }
    try {
      if (langSwitched) {
        await page.evaluate((v) => {
          if (v === null) localStorage.removeItem("jishu-hub-lang");
          else localStorage.setItem("jishu-hub-lang", v);
        }, langBefore);
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        // 读回：localStorage 里的值 = 运行前的值才算「已还原」（原来只置一个标志位）
        const back = await page.evaluate(() => localStorage.getItem("jishu-hub-lang")).catch(() => undefined);
        sideEffects.langRestored = back === langBefore;
        if (!sideEffects.langRestored) {
          log(`⚠ 界面语言没有还原：运行前是 ${JSON.stringify(langBefore)}，读回 ${JSON.stringify(back)}——请手动改回`);
          exitCode = exitCode || 1;
        }
      }
    } catch {
      /* 还原失败如实体现在报告里 */
    }
    meta.langSwitched = langSwitched;
    await app.close().catch(() => {});
  }

  sideEffects.sessionsCreated = state.sessionsCreated;
  sideEffects.clipboard = state.clipboard;
  sideEffects.clipboardUntouched = state.clipboardUntouched;
  sideEffects.clipboardFallback = state.clipboardFallback || 0;
  sideEffects.clipboardFallbackReasons = state.clipboardFallbackReasons;
  sideEffects.installedTotal = state.installedLog.length;
  sideEffects.curatedInstalledLeft = Object.keys(state.curatedTarget || {}).length;
  meta.interrupted = interrupted;
  meta.sideEffects = sideEffects;

  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ ...meta, results, log: logLines, approvalLog: app.approvalLog }, null, 2));
  fs.writeFileSync(path.join(out, "test-log.md"), renderLog(meta, results, { state, approvalLog: app.approvalLog }));
  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.ok && r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;
  log(`\n== 汇总：通过 ${passed} · 跳过 ${skipped} · 失败 ${failed}${interrupted ? "（用户中断）" : ""}`);
  log(`结果：${path.join(out, "result.json")}`);
  log(`日志：${path.join(out, "test-log.md")}`);
  if (interrupted && exitCode === 0) return 130;
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
