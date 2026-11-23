# scripts/e2e —— jishu-hub 界面自动化测试

用 Playwright 连上正在运行的 jishu-hub（Windows 版，WebView2），像真人一样点按钮、打字、拖拽，并把结果写成报告。
只连接、不启动浏览器、不下载浏览器；**不进安装包**（见文末「打包守卫」）。

## 在一台新电脑上跑（四步）

```bash
# 1. 取得仓库并装依赖（需要 Node.js 20 以上）
git clone <仓库地址> && cd jishu-hub && npm install

# 2. 带调试口启动应用（自动找已安装的应用；找不到就先装应用）
node scripts/e2e/start.mjs

# 3. 跑测试
node scripts/e2e/run.mjs --suite smoke          # 基础冒烟：不需要模型和网络
node scripts/e2e/run.mjs --suite conversation   # 对话：需要已配置可用模型
node scripts/e2e/run.mjs --suite market         # 安装扩展：需要联网
node scripts/e2e/run.mjs --suite full           # 全量

# 4. 看报告：结果目录里的 test-log.md / result.json / screenshots/
```

常用参数：

| 参数 | 作用 |
|---|---|
| `--project <项目名>` | 在指定项目里跑（默认：应用当前所在项目） |
| `--out <目录>` | 结果输出目录（默认 `scripts/e2e/results/<时间戳>/`，不入库；要留进版本文档就指到 docs 下） |
| `--only I1,I3` | 只跑指定编号（还原类用例始终执行） |
| `--list` | 列出场景包里的用例 |
| `--checklist` | 输出四字段用例清单（markdown），可直接落 `06-测试清单.md` |
| `--no-lang-switch` | 界面不是中文时不自动切换 |

退出码：`0` 全部通过（跳过不算失败）；`1` 有失败；`2` 无法运行（没连上应用 / 前置不满足）。

## 目录

| 文件 | 作用 |
|---|---|
| `lib-pw.mjs` | 驱动库：连接应用、按名字找按钮并点击、输入、截图、调用后端命令、读会话记录 |
| `kit.mjs` | 积木公共件（跳过语义、演示图现画等小工具） |
| `blocks/*.mjs` | **积木**：一条条可复用的检查，统一写法 |
| `suites.mjs` | **场景包**：按依赖把积木组合起来 |
| `run.mjs` | 运行入口 |
| `start.mjs` | 带调试口启动应用 |
| `check-not-bundled.mjs` | 打包守卫：确认这些测试文件没进安装包 |

## 场景包

| 场景包 | 依赖 | 包含 |
|---|---|---|
| `smoke` | 无 | 驱动能力（附着、真实点击、命中检查、多命中报错、截图尺寸、命令直调、错误捕获）、输入区菜单、切会话、切项目标签、套装卡 |
| `conversation` | 可用模型 | 回车发送、暂存消息拖拽调序、附件上传、工具挂载 |
| `market` | 联网 | 安装扩展（遇冲突卡取消并换候选）、纯键盘完成安装；每个安装用例装完即卸，末条兜失败残留 |
| `full` | 以上全部 | |

某条用例的前提不满足时（例如只有一个项目、没有可安装的扩展、模型没配好），它会标为「跳过」并写明原因，不算失败。

安装类用例依赖网络状况：候选扩展要从网络拉取，同一个候选时快时慢。每个候选最多等 90 秒，五个候选都没装成就跳过，并写明每个候选的结果（冲突卡取消 / 超时 / 失败）。

## 怎么加一块积木

在 `blocks/` 里按统一写法加一条，再到 `suites.mjs` 放进对应场景包：

```js
{
  id: "X1",                                   // 编号：截图、日志、清单都对它
  name: "一句话说清测什么",
  feature: "涉及的功能",
  steps: "操作步骤",
  expect: "通过条件",
  needs: "none",                              // none / model / network
  run: async (ctx) => {
    await ctx.app.ensureWorkspace();          // 每块开头：回到工作区、清残留弹层
    // … 用 ctx.app 的助手操作界面 …
    if (前提不满足) ctx.skip("原因");           // 跳过
    return { 关键事实: true };                 // 正常返回 = 通过；抛错 = 失败
  },
}
```

三条规矩：

1. **不写死机器信息**。项目名、会话标题、已装扩展、路径都在运行时探测，或通过 `--project` / `--out` 传入。
2. **每块自给自足**。自己新建会话、自己等回合结束，不依赖别的用例先跑。
3. **导航后必校验落点**。切换页面或会话用 `ctx.app.openSession` / `switchProject` / `navClick`，它们会核对是否真的到了目标。

`ctx` 提供：`app`（驱动库）、`page`、`expect`、`state`（跨用例共享）、`shot(名字)`（截图）、`fixture(名字)`（演示文件路径）、`truth(起始时刻)`（会话记录里的真实消息序列）、`skip(原因)`。

## 前提与限制

- **只支持 Windows**：依赖 WebView2 的远程调试口。
- **界面定位按中文界面编写**。界面不是中文时，运行器会临时切到中文，结束后还原。
- 应用必须已完成首次引导、进入主界面。
- 开发模式请自己带环境变量启动：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run tauri dev`，再跑 `run.mjs`。
- 会话记录默认从 `~/.jishu-agent/agent/sessions` 读取，位置不同时设环境变量 `JISHU_AGENT_SESSIONS_DIR`。

## 测试会动什么

- 在当前项目里**新建测试会话**（对话类用例），不会删除。
- 切会话、切项目会清掉对应的**未读标记**（产品的「查看即已读」行为）。
- 市场类用例会**真实安装扩展**，每个安装用例装完即卸（另一个安装用例还要用候选）；遇到「能力重叠」确认卡一律取消，不会停用已装的扩展。
- 附件用例会短暂占用**系统剪贴板**，用后还原原来的文本。
- `start.mjs` 启动的应用带着调试口；测完执行 `node scripts/e2e/start.mjs --stop` 关掉，再按平时方式打开即可。

## 打包守卫

测试文件只在仓库里，不进安装包。`npm run build` 会在前端构建后自动执行 `node scripts/e2e/check-not-bundled.mjs`，检查三处打包来源：

1. `dist/`（前端产物）：文件名和内容不得出现测试基建字样；
2. `src-tauri/tauri.conf.json` 的打包清单：不得指向 `scripts/`；
3. `third_party/pi-runtime.zip`（随包资源）：包内文件名不得出现 `scripts/e2e`、`lib-pw`。

任一处命中就中止打包。`node scripts/e2e/check-not-bundled.mjs --selftest` 可确认守卫本身工作正常。

## 连不上应用时

| 现象 | 处理 |
|---|---|
| `无法附着应用` | 先执行 `node scripts/e2e/start.mjs` |
| `应用已在运行，但没开调试口` | 加 `--restart` 重启（有会话正在写入时会拒绝，等它结束） |
| `找不到 jishu-hub.exe` | 用 `--exe <路径>` 指定，或设置环境变量 `JISHU_HUB_EXE` |
| `应用未进入主界面` | 先在应用里完成首次引导 |
| 调试口起不来 | 通常是上一个实例的网页进程还带着「无调试参数」的状态被复用——`start.mjs --restart` 会处理；手动做法是结束所有应用进程后重新执行 |
