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
 *   node scripts/e2e/run.mjs --suite search                 搜索体验（SE-1~SE-3、SE-7、SE-8、SE-11 不需要模型；其余需要可用模型）
 *   node scripts/e2e/run.mjs --suite unread                 未读标记（需要模型；发一条慢消息并在回合结束前切走）
 *   node scripts/e2e/run.mjs --suite tasksession            任务会话：滚动位置 + 切节点（需要模型；任务会话与普通会话走同一个打开函数）
 *   node scripts/e2e/run.mjs --suite full                   全量
 *   可选：--project <项目名>   在指定项目里跑（默认：应用当前所在项目）
 *         --out <目录>        结果输出目录（默认 scripts/e2e/results/<时间戳>/，已 gitignore）
 *         --only I1,I3        只跑指定编号（还原类用例始终执行）
 *         --list              列出场景包里的用例
 *         --checklist         输出四字段用例清单（markdown，可直接落 06-测试清单.md）
 *         --no-lang-switch    界面不是中文时不自动切换（默认：临时切中文，结束后还原）
 *
 * 退出码：0 = 全部通过（跳过不算失败）；1 = 有失败；2 = 无法运行（未附着 / 前置不满足）。
 * 产物：<out>/result.json、<out>/test-log.md、<out>/screenshots/*.png
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

const USAGE = `用法：node scripts/e2e/run.mjs --suite <smoke|conversation|market|fixround|compact|search|unread|tasksession|full> [--project 名] [--out 目录] [--only I1,I3]
       node scripts/e2e/run.mjs --suite <名> --list        列出用例
       node scripts/e2e/run.mjs --suite <名> --checklist   输出四字段用例清单（markdown）
场景包：${Object.entries(SUITES)
  .map(([k, v]) => `\n  ${k.padEnd(13)} ${v.name}——${v.desc}`)
  .join("")}`;

const NEEDS_TEXT = { none: "无", model: "可用模型", network: "联网" };
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

function renderLog(meta, results) {
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
  lines.push(`- 结果：**通过 ${passed} · 跳过 ${skipped} · 失败 ${failed}**\n`);
  lines.push("| 编号 | 用例 | 依赖 | 结果 | 耗时 | 关键事实 / 原因 |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of results) {
    const verdict = !r.ok ? "❌ 失败" : r.skipped ? "⏭ 跳过" : "✅ 通过";
    const detail = !r.ok ? r.error : r.skipped ? r.skipped : JSON.stringify(r.facts ?? null);
    lines.push(`| ${r.id} | ${cell(r.name)} | ${NEEDS_TEXT[r.needs] || r.needs} | ${verdict} | ${r.ms}ms | ${cell(detail).slice(0, 420)} |`);
  }
  const se = meta.sideEffects;
  lines.push(`\n## 副作用\n`);
  lines.push(`- 新建测试会话：${se.sessionsCreated} 个（留在当前项目，未删除）`);
  const clip = se.clipboard.length ? se.clipboard.map((c) => (c.clipboardRestored ? "已还原" : "未还原")).join("，") : "未占用";
  lines.push(`- 系统剪贴板：${clip}`);
  if (se.clipboardFallback) lines.push(`- ⚠ 有 ${se.clipboardFallback} 个附件用例没走成「系统剪贴板 + Ctrl+V」，回落到了合成粘贴事件（系统剪贴板当时被别的进程占用）`);
  lines.push(`- 测试安装的扩展：${se.installedTotal ? `${se.installedTotal} 个，${se.installedLeft ? "有残留（见还原用例）" : "已全部卸载"}` : "无"}`);
  if (se.curatedInstalledLeft) lines.push(`- ⚠ 本轮装卸的精选件仍有 ${se.curatedInstalledLeft} 个未卸载（见还原用例 FX2）`);
  if (meta.suiteName === "fixround") lines.push("- F7 会真装一个冲突扩展并选「停用并安装」（临时停用与它撞名的已装扩展）；用例内卸载即自动恢复，登记簿若仍有冲突停用记录说明还原未完成");
  if (meta.suiteName === "斜杠命令与压缩") lines.push("- 本场景包向每个测试会话发送两条各约 9 万字符的「接口清单」消息（让会话大到可压缩），占用模型用量；这些会话留在当前项目里，标题较长");
  lines.push(`- 界面语言：${se.langRestored ? "临时切换后已还原" : "未改动"}`);
  lines.push(`- 其它：切会话/切项目会清对应会话或项目的未读标记（产品行为：查看即已读）`);
  return lines.join("\n") + "\n";
}

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
  fs.mkdirSync(path.join(out, "screenshots"), { recursive: true });
  const logLines = [];
  const log = (m = "") => {
    logLines.push(String(m));
    console.log(m);
  };
  log(`场景包：${suiteName}（${suite.desc}）｜输出：${out}`);

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
    modelOk: null,
    baselineSources: [],
    sessionsCreated: 0,
    clipboard: [],
  };
  const ctx = {
    app,
    page,
    expect,
    state,
    cfg: { suite: suiteName, out, project: null },
    shot: async (name) => app.shot(path.join(out, "screenshots", `${name}.png`)),
    fixture: (name) => ensureDemoPng(path.join(out, "fixtures", name)), // 演示图运行时现画（仓库忽略全部 png，不入库）
    truth: async (sinceMs) => {
      const h = await app.sessionHeader();
      return h ? readSessionUsers(h.id, sinceMs) : null;
    },
    skip(reason) {
      throw new Skip(reason);
    },
    since: startedAt,
  };

  const results = [];
  const meta = { suiteName, suiteDesc: suite.desc, time: new Date(startedAt).toLocaleString("zh-CN", { hour12: false }) };
  const sideEffects = { sessionsCreated: 0, clipboard: [], installedTotal: 0, installedLeft: 0, langRestored: false };
  let exitCode = 0;
  let langSwitched = false;
  let langBefore = null;

  const runCase = async (c) => {
    log(`\n▶ ${c.id} ${c.name}`);
    const t0 = Date.now();
    const limit = Number(c.timeoutMs || 240000);
    const row = { id: c.id, name: c.name, needs: c.needs, cleanup: !!c.cleanup };
    let timer;
    // 超时后原用例的异步还在跑：它的后续报错必须有人接，否则未处理的 rejection 会让进程退出
    const task = Promise.resolve().then(() => c.run(ctx));
    task.catch(() => {});
    try {
      row.facts = await Promise.race([task, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`用例超时（${limit}ms）`)), limit)))]);
      row.ok = true;
    } catch (e) {
      if (e instanceof Skip) {
        row.ok = true;
        row.skipped = e.message;
      } else {
        row.ok = false;
        row.error = String(e?.message || e).slice(0, 1800);
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
    }
    row.ms = Date.now() - t0;
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
      log("界面语言已临时切到中文（运行结束后还原）");
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
    log(`项目：${project || "(未识别)"}｜已装扩展基线：${state.baselineSources.length} 个`);

    const ordered = [...cases.filter((c) => !c.cleanup), ...cases.filter((c) => c.cleanup)];
    for (const c of ordered) {
      const row = await runCase(c);
      results.push(row);
      if (!row.ok) exitCode = 1;
      const verdict = !row.ok ? "❌ 失败" : row.skipped ? "⏭ 跳过" : "✅ 通过";
      const note = !row.ok ? row.error : row.skipped ? row.skipped : "";
      log(`  ${verdict}  ${row.ms}ms${note ? " ｜ " + String(note).slice(0, 300) : ""}`);
      // 现场复位：失败的用例常把弹层、输入框里的半截内容留在屏幕上，下个用例一开头就落空
      await app.cancelResidualDialog().catch(() => {});
      const leftover = await app.clearComposerLeftover().catch(() => "");
      if (leftover) log(`  （已清掉上一用例留在输入框的内容：${leftover.slice(0, 40)}）`);
    }
  } catch (e) {
    log(`运行中止：${e?.message || e}`);
    exitCode = 2;
  } finally {
    try {
      if (langSwitched) {
        await page.evaluate((v) => {
          if (v === null) localStorage.removeItem("jishu-hub-lang");
          else localStorage.setItem("jishu-hub-lang", v);
        }, langBefore);
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        sideEffects.langRestored = true;
      }
    } catch {
      /* 还原失败如实体现在报告里 */
    }
    await app.close().catch(() => {});
  }

  sideEffects.sessionsCreated = state.sessionsCreated;
  sideEffects.clipboard = state.clipboard;
  sideEffects.installedTotal = state.installedLog.length;
  sideEffects.installedLeft = state.installed.filter((s) => !state.baselineSources.includes(s)).length;
  sideEffects.curatedInstalledLeft = Object.keys(state.curatedTarget || {}).length;
  sideEffects.clipboardFallback = state.clipboardFallback || 0;
  meta.sideEffects = sideEffects;

  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ ...meta, results, log: logLines }, null, 2));
  fs.writeFileSync(path.join(out, "test-log.md"), renderLog(meta, results));
  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.ok && r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;
  log(`\n== 汇总：通过 ${passed} · 跳过 ${skipped} · 失败 ${failed}`);
  log(`结果：${path.join(out, "result.json")}`);
  log(`日志：${path.join(out, "test-log.md")}`);
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
