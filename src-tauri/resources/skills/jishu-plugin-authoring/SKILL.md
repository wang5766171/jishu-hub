---
name: jishu-plugin-authoring
description: 创建/安装 Jishu Hub 插件前必读——用户想改变客户端本身时（做主题/换配色/聊天背景/新图表渲染/接入新智能体/新面板/给 AI 新能力）读此指南。四层指南：①判断指南（用户想要什么 → 该造哪种插件：智能体工具/会话界面组合式/混合代码/流水线/自建智能体/MCP/Skill/外观主题）；②七形态可复制模板（plugin.toml + component.js/theme.css 完整示例，含代码块渲染接管变体——echarts/katex 类图表插件：block-renderer + api.loadAsset 引库）；③混合插件 component.js API 参考（JishuPlugin.register/h/useState/loadAsset/props 形状）；④陷阱与最佳实践。配套 CLI：plugins add（统一寻址/目录桥接）/ validate / add-hybrid。用户说"加一个插件/让 AI 能 X/在会话里显示 X/换个主题/接个新智能体"时按本指南产出并安装。
---

# Jishu Hub 插件创作指南（四层）

用户想在 Jishu Hub 里加插件时，按下面四层走：**先判断形态 → 取模板填空 →
（混合式）查 API 参考 → 过陷阱清单 → 用 CLI 安装**。

## 第一层：判断指南（先读这个）

**第一个问题是"用户想要什么"，不是"选哪种插件"。**

```text
用户想要什么？
├─ "让 AI 能做 X"（给 agent 新能力）
│   ├─ 是一个命令行命令？ → 智能体侧·CLI 工具（[tool] 段）
│   ├─ 接入外部系统/数据库/API？ → MCP 工具（[mcp] 段）
│   ├─ 部署可复用知识/流程？ → Skill（[skill] 段，文件夹形态）
│   └─ 需要改变 agent 运行行为？ → pi 扩展（[pi_extension] 段，代码原文透传）
├─ "在会话里显示 X"（用户看到什么）
│   ├─ 面板/统计/列表/图表？ → 会话侧·组合式（纯 TOML，零代码）
│   │   数据面板 → source: messages/turns/task + mount: dock-panel/rail-widget
│   │   通知提醒 → source: signal + mount: event-hook + action: desktop-notify
│   │   代码块增强 → source: code-block/block-type + mount: block-renderer
│   ├─ 现有积木不够、要自定义渲染？ → 会话侧·混合式（TOML + component.js）
│   ├─ 新图表渲染（echarts/katex/vega…接管代码块）？ → 混合式·渲染插件
│   │   （模板 3 变体：block-renderer + api.loadAsset 引入库，见第二层）
│   └─ 界面主题/聊天背景/换配色？ → 外观主题插件（模板 7：[theme] + theme.css）
└─ "接入一个新智能体"（claude/gemini/codex…） → 自建智能体（kind="agent" + [transport]）
```

**判据细则**：
- 数据在会话里（消息/轮次/任务/信号）→ 会话侧；数据/能力在 agent 手里 → 智能体侧。
- 不确定时追问用户："你想在哪里看到它？AI 用，还是你用？"
- 一次只造一个插件；组合需求拆多个。

## 第二层：形态模板（复制填空）

所有会话侧插件的 id **必须以 `session.` 开头**。智能体侧（agents/）无此限制。

### 模板 1：CLI 工具（智能体侧，agents/<id>.toml）

```toml
schema = 1

[info]
id = "my-qrcode"
name = "二维码生成"
description = "把文本/URL 生成二维码 PNG。用户要求生成二维码时使用。"
kind = "tool"
icon = "qr"

[tool]
usage = "qrencode -o {{output}} -s 10 {{text}}"
description = "生成二维码图片。text：要编码的内容；output：输出 PNG 路径。"
examples = ["生成 https://example.com 的二维码到 /tmp/qr.png"]
```

安装：`jishu-cli plugins add my-qrcode.toml`

### 模板 2：组合式渲染——数据面板（会话侧，纯 TOML）

```toml
[plugin]
id = "session.my-stats"
name = "我的统计面板"
description = "会话消息统计"
kind = "session-composed"

[source]
type = "messages"          # messages | turns | task | signal
# aggregate = "tool-stats" # 可选聚合器（tool-stats 等）

[render]
component = "render.list"  # 内置渲染件键
mount = "dock-panel"       # dock-panel | rail-widget | sidebar-panel | composer-trailing
# 可选（dock-panel 专属）：停靠槽位 slot = "float" | "left" | "right"（缺省
# float——悬浮窗形态：右上角悬浮、高度自适应内容、可拖动/调大小；缩小后
# 变胶囊与能力中心按钮并排，组合插件胶囊显示图标+面板名）。
slot = "float"
# 可选（dock-panel 专属，v0.9.5 需求12 通用底座）：自动打开声明——匹配的工具
# 被 agent 调用时本面板自动展开。tool=工具名；inputContains=输入字段匹配
#（可选，如 rpiv-todo 的 action="create"——只创建触发，查询/更新不打扰）。
# 会话首轮（历史回放）不触发，仅订阅后的增量调用。
autoOpenOn = { tool = "todo", inputContains = { action = "create" } }

[[config]]
key = "showDetails"
type = "switch"
label = "显示明细"
default = true
```

**源 × 挂载配对矩阵**（非法组合安装即拒）：

| 挂载 | 合法源 |
|---|---|
| dock-panel / sidebar-panel / rail-widget / composer-trailing | messages / turns / stream-state（dock、sidebar 另收 task） |
| block-renderer | code-block（声明 languages）/ block-type（声明 blockTypes） |
| event-hook | signal（声明 signals） |

安装：`jishu-cli plugins add session.my-stats.toml`

### 模板 3：混合式（会话侧，TOML + component.js）

```toml
[plugin]
id = "session.turn-cost"
name = "轮次花销"
description = "每轮结束在输入框旁显示本轮花销"
kind = "session-composed"

[source]
type = "turns"

[render]
component = "@file:component.js"
mount = "composer-trailing"
```

`component.js`（同目录）：

```js
JishuPlugin.register("session.turn-cost", {
  version: 1,
  component: (api) => (props) => {
    const turns = props.payload.turns ?? [];
    const last = turns[turns.length - 1];
    return api.h("span", { className: "text-xs text-muted-foreground" },
      last?.cost ? `¥${last.cost}` : "—");
  },
});
```

安装：`jishu-cli plugins add-hybrid <目录>`（目录含 plugin.toml + component.js）。

**混合式支持 block-renderer（代码块渲染接管，v0.9.5 需求14 起）**——见下方
变体；export-file 动作仍不支持（导出依赖内置渲染件能力）。

### 模板 3 变体：渲染插件（接管 ```代码块，如 echarts/katex/vega）

让 agent 输出的 ```echarts 代码块渲染成真正的图表——库文件随插件目录分发，
经 `api.loadAsset` 注入（**资产必须平铺在插件根目录**，子目录不识别）：

```toml
[plugin]
id = "session.echarts-render"
name = "ECharts 图表渲染"
description = "echarts 代码块渲染为交互图表"
kind = "session-composed"

[source]
type = "code-block"
languages = ["echarts"]          # 封闭集：只接管显式声明的语言，不能通配

[render]
component = "@file:component.js"
mount = "block-renderer"
fallback = "render.mono-text"    # 组件崩溃时回退源码视图（须为内置渲染键）

[[config]]
key = "theme"
type = "string"
label = "图表主题"
default = "default"
```

`component.js` 关键形态（完整骨架——初始化库、进入视口再渲染、容错）：

```js
JishuPlugin.register("session.echarts-render", {
  version: 1,
  component: (api) => (props) => {
    // payload 与其他挂载统一：{ kind: "code-block", language, code }
    const { code } = props.payload ?? {};
    const [el, setEl] = api.useState(null);
    const [err, setErr] = api.useState(null);
    // 库只加载一次（hub 侧模块级缓存，多代码块共享）；
    // 进入视口再初始化（消息流逐块实例化——性能纪律）。
    api.useEffect(() => {
      if (!el) return;
      let disposed = false;
      api.loadAsset("echarts.min.js", "script").then(() => {
        if (disposed || !el) return;
        const ECharts = globalThis.echarts;   // 库挂的全局名以实际为准
        const chart = ECharts.init(el);
        chart.setOption(JSON.parse(code));
      }).catch((e) => setErr(String(e)));
      return () => { disposed = true; };
    }, [el, code]);
    if (err) return api.h("div", { className: "text-xs text-red-500" }, err);
    return api.h("div", { ref: setEl, style: { width: "100%", height: "320px" } });
  },
});
```

要点：
- **语言封闭集**是硬边界——只接管声明的语言；用户插件之间同语言互斥
  （安装期拒绝并指认已有接管者），但可遮蔽内置渲染（如自建 mermaid 件
  优先于内置）。
- **资产平铺**：echarts.min.js 放插件根目录；`loadAsset(rel, kind)` 只认
  `_files` 清单内的浅层文件（script=注入并等待、url/style=仅返回 URL）。
- **DOM 净化纪律**：代码块内容来自对话/模型输出（不可信）——`JSON.parse`
  失败要 catch；绝不用 innerHTML 直插 code 内容；库初始化参数全部走
  JSON.parse 后的对象。
- **fallback 声明**：组件崩溃时 hub 渲染该内置键（源码视图），会话不空白。

### 模板 4：通知提醒（会话侧，event-hook）

```toml
[plugin]
id = "session.my-notify"
name = "回合完成通知"
description = "每轮完成弹桌面通知"
kind = "session-composed"

[source]
type = "signal"
signals = ["turn-complete"]   # turn-complete | approval-request | task-run-failed

[render]
component = "render.none"
mount = "event-hook"

[[action]]
type = "desktop-notify"

[[config]]
key = "notifyTurnComplete"
type = "switch"
label = "回合完成时通知"
default = true
```

### 模板 5：流水线（会话侧，[[pipeline.stages]]）

```toml
[plugin]
id = "session.my-flow"
name = "视频制作流水线"
description = "需求→分镜→素材→成片"
kind = "session-composed"

[[pipeline.stages]]
name = "需求讨论"
template = "phase.discuss"   # 内置模板：phase.discuss/plan/execute/review

[[pipeline.stages]]
name = "分镜设计"
prompt = "依据已确认的需求产出分镜表（表格形式，每镜头一行）"
gate = "confirm"             # 需要用户确认才进下一阶段
```

流水线清单**可以不写 [source]/[render]**（纯编排形态）；也可以与渲染臂共存
（同时出面板和流水线）。阶段模板引用 `phase.discuss/plan/execute/review`，
自定义阶段用 prompt + 可选 gate。

安装：`jishu-cli plugins add session.my-flow.toml`

### 模板 6：自建智能体（agents/<id>.toml，kind="agent"）

```toml
schema = 1
kind = "agent"        # 顶层字段（不在 [info] 内）

[info]
id = "gemini-cli"
display_name = "Gemini CLI"
description = "Google Gemini 命令行智能体"
icon = "gemini"

[transport]
kind = "cli"
chat_command = ["gemini", "-m", "gemini-2.5-pro", "{prompt}"]
```

安装（单文件）：`jishu-cli plugins add gemini-cli.toml`。

**模板 6 变体：桥接智能体（目录形态，L2 转换层——目标 CLI 有私有协议时）**

目标 CLI 不讲 ACP/纯 CLI 流时，写一个桥脚本把它的输入输出翻译为 ACP
（hub 的 acp_runtime 通用 loop 直接接住）。桥脚本**随插件目录分发**，
命令里用 `{plugin_dir}` 引用（安装期常量；{prompt} 等动态变量被校验拒绝）：

```text
zcode-agent/
├── plugin.toml     # 见下
└── bridge.js       # 转换层：ACP JSON-RPC（stdin/stdout）↔ zcode 行协议
```

```toml
schema = 1
kind = "agent"        # 顶层字段（不在 [info] 内）

[info]
id = "zcode"
display_name = "zcode CLI"
description = "zcode 命令行智能体（经桥接入）"
icon = "terminal"

[transport]
kind = "acp"
acp_command = ["node", "{plugin_dir}/bridge.js", "--stdio"]

[probe]
command = "zcode"
version_args = ["--version"]
# 私有路径安装时显式列候选（PATH 查找探测不到的盲区）：
paths = ["D:\tools\zcode\zcode.exe", "zcode"]

[capabilities]
abort = false        # 能力诚实：桥没实现的不声明（image_input/stream_text 同）
```

`bridge.js` 骨架（极简 Node 桥——stdin 读 ACP JSON-RPC 行，子进程 spawn
目标 CLI，把 TextDelta 类内容映射回 ACP initialize/session/prompt 事件；
以 claude-agent-acp 为参照补全协议细节）：

```js
const { spawn } = require("child_process");
const child = spawn("zcode", ["--print", "--stdin"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("
")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    handle(JSON.parse(line)); // ACP 请求 → 翻译 → child.stdin.write(...)
  }
});
child.stdout.on("data", (d) => {
  for (const line of d.toString().split("
")) {
    if (!line.trim()) continue;
    // 目标 CLI 行协议 → ACP 响应/事件（session/update）回写 stdout
  }
});
function handle(msg) { /* initialize/session/new/prompt/abort 的最小实现 */ }
```

安装（目录形态）：`jishu-cli plugins add ./zcode-agent`——确认卡为
**最高警示级**（随插件启动可执行体，启用前核验 bridge.js）；卸载即整体
移除（含桥），不污染全局环境。

### 模板 7：外观主题插件（会话侧，[theme] + theme.css，v0.9.5 需求14）

换皮肤不等发版——主题与聊天背景是插件可贡献的能力点；装好后「管理 → 外观」
出现主题卡，点选即全 App 生效（互斥；未选 = 内置基座）。

```toml
[plugin]
id = "session.theme-forest"
name = "森林绿"
description = "深绿主题，聊天背景用带纹理的绿色"
kind = "session-composed"
category = "appearance"        # 归「外观」分类

[theme]
css = "@file:theme.css"        # 只覆盖公开令牌（见下表）
base = "dark"                  # 基座三档：light/colorful/dark（缺省 dark）
preview = ["#0a1f14", "#123524", "#e8f5ec"]  # 外观页色卡（背景/面板/文字）

[render]
mount = "app-theme"            # 全局外观挂载（无 source、无 component——
                               # 渲染体就是 theme.css 本身）
```

`theme.css`（同目录；**只能覆盖公开令牌**，选择器固定 `[data-jishu-theme="…"]`）：

```css
[data-jishu-theme="session.theme-forest"] {
  --color-background: #0a1f14;          /* 全局底 */
  --color-layer-0: #0e2818;             /* 侧栏底 */
  --color-layer-1: #123524;             /* 面板底 */
  --color-layer-2: #1a4632;
  --color-layer-3: #235840;
  --color-layer-4: #2d6b4f;
  --message-user-bg: #1f5138;           /* 注意：message 系无 --color- 前缀 */
  --message-assistant-bg: #10281b;
  --message-thinking-bg: #0d2216;
  background-image: url(@file:bg.jpg);  /* 背景图：@file: 记号引用平铺资产 */
  background-size: cover;
}
```

**公开令牌契约**（只许覆盖这些；两段命名并存别写错）：

| 用途 | 变量 |
|---|---|
| 全局底 | `--color-background` |
| 层级面 | `--color-layer-0` ~ `--color-layer-4` |
| 气泡 | `--message-user-bg` / `--message-assistant-bg` / `--message-thinking-bg`（无前缀） |

要点：
- **背景图资产**：图放插件根目录，css 里写 `url(@file:bg.jpg)`（与清单
  @file: 记号同构；装载时自动展开为 asset 地址）——**必须平铺**，子目录不识别。
- **不承诺任意 CSS**：选择器白名单 = `[data-jishu-theme="<插件id>"]`；
  乱写变量名不影响（未消费），但契约外样式不保证跨版本。
- 安装：`jishu-cli plugins add-hybrid <目录>`（主题形态免 component.js）。
- 生成后自验：`jishu-cli plugins get <id>` 回查 → 管理页确认卡启用 →
  「管理 → 外观」选中新主题卡。

## 第三层：component.js API 参考（混合式）

注册契约：

```js
JishuPlugin.register(pluginId, {
  version: 1,                       // 必须 === 1（当前 PLUGIN_API_VERSION）
  component: (api) => Component,    // api 见下
});
```

`api` 注入面（v1）：

| API | 对应 React | 说明 |
|---|---|---|
| `api.h(tag, props, ...children)` | createElement | 虚拟节点构造（组件里 return api.h(...)） |
| `api.useState(init)` | useState | 状态钩子 |
| `api.useEffect(fn, deps)` | useEffect | 副作用钩子 |
| `api.useMemo(fn, deps)` | useMemo | 记忆化 |
| `api.useRef(init)` | useRef | 引用 |
| `api.useCallback(fn, deps)` | useCallback | 回调记忆化 |
| `api.t(key, fallback)` | — | i18n 取词 |
| `api.cn(...classes)` | clsx | className 合并 |
| `api.loadAsset(rel, kind?)` | — | 加载插件目录资产（v0.9.5 需求14 加法）：rel=相对根目录的平铺文件名；kind: "script"=注入 `<script>` 并等待 onload（同一库全局只加载一次）、"url"/"style"=仅返回 asset URL。路径限定插件目录内（拒绝 `..`/绝对路径）；存在性以文件清单为白名单——**资产必须平铺在插件根目录**。不提供 fetch/网络通道（库由你放进插件目录随插件分发） |

组件 props 形状：

```ts
{
  payload: // 源数据，按 [source].type 定形状：
    //   messages → { kind: "aggregate", data: Message[] }（可配聚合器）
    //   turns    → { kind: "turns", turns: TurnInfo[], activeIndex, jump(i) }
    //   task     → { kind: "task", task: TaskInfo }
    //   code-block（block-renderer 挂载）→ { kind: "code-block", language, code }
    //   block-type（block-renderer 挂载）→ { kind: "block", blockType, block }
    //   tool-result（tool-output 挂载）→ { kind: "tool-result", toolName, output }
    // Message = { role, blocks: Block[] }；Block 按类型：
    //   { type: "text", text }
    //   { type: "thinking", thinking }
    //   { type: "tool_use", id, text: 工具名, input: 参数对象 }
    //   { type: "tool_result", id, output: 文本, isError,
    //     details?: 对象 }  // v0.9.5 新增：工具结构化数据——如 rpiv-todo
    //                       // 的全量任务快照（details.tasks），可做实时面板
    //   { type: "image" } / { type: "phase_divider", title }
  options: // 配置面键值（[[config]] 声明的当前值，保存即热生效）
  actions: // 引擎装配的动作条 [{ key, label, run() }]——渲染按钮并转发
}
```

常见模式：

```js
// 列表渲染
component: (api) => (props) =>
  api.h("ul", null,
    (props.payload.data ?? []).map((m, i) =>
      api.h("li", { key: i }, String(m.role ?? "")))),

// 事件 + 状态
component: (api) => (props) => {
  const [open, setOpen] = api.useState(false);
  return api.h("button", { onClick: () => setOpen(!open) }, open ? "收起" : "展开");
},
```

## 第四层：陷阱与最佳实践

1. **id 必须 `session.` 前缀**（会话侧）；安装通道直接拒绝其他前缀。
2. **`register` 用两参数形态** `register(id, factory)`——单参数形态兼容但依赖
   匿名槽匹配，不推荐。
3. **`version: 1`** 写全——缺失或写 2 会装载失败（明确迁移错误）。
4. **不要在组件外维护可变状态**——插件重载/热更会重建组件，闭包变量会丢。
5. **组件内 try-catch 包住可能出错的取值**（`props.payload.x?.y`）——未捕获
   异常会触发 ErrorBoundary 自动停用整个插件。
6. **render 中 DOM 节点别超百级**——性能预算（h() 调用每帧 ≤100 量级）。
7. **配对矩阵先对照**（第二层表格）——turns 配 block-renderer 这类组合安装
   即拒，不会静默错乱。
8. **流水线阶段优先用内置模板**（phase.discuss/plan/execute/review），只对
   特殊阶段写自定义 prompt。
9. **先 validate 再 add**：`jishu-cli plugins validate <目录>`（hub 运行中走
   与 GUI 向导同一份校验器；hub 未运行仅基础检查并提示 ⚠）。
10. **CLI 安装后的生效链**：会话侧插件默认禁用 + 安装确认卡（hub 界面点
    「启用」）——这是设计行为（安全阀），不是安装失败。
11. **渲染插件两条铁律**（block-renderer 接管类）：资产平铺插件根目录
    （loadAsset 白名单只认浅层清单）；渲染内容来自模型输出（不可信）——
    JSON.parse 必 catch、严禁 innerHTML 直插，DOM 净化自负其责。
12. **语言接管互斥**：用户插件之间同语言只允许一个（安装第二个会被拒并
    指认先装者）；遮蔽内置渲染（mermaid 等）不受限——用户件优先于内置。

## 安装与管理命令速查

| 命令 | 说明 |
|---|---|
| `jishu-cli plugins add <toml 或目录>` | 统一寻址：TOML 文件——内容含 [plugin].id → 组合式（落 plugins/）；含 [info] → 智能体/工具（落 agents/）。目录（v0.9.5 需求14 起）——智能体桥插件（[info] 清单 + bridge.js 等附带文件整体落 plugins/<id>/，确认卡最高警示）；组合家族目录仍走 add-hybrid |
| `jishu-cli plugins add-hybrid <目录>` | 混合插件目录包（plugin.toml + component.js + 资产文件——目录内浅层文件全部随装） |
| `jishu-cli plugins validate <目录或 toml>` | 校验不安装（hub 运行中 = GUI 同款校验器） |
| `jishu-cli plugins list` / `get <id>` / `update <id> <toml>` / `remove <id>` | 管理（get/update/remove 双落点统一寻址） |
| `jishu-cli plugins edit <id> --field section.key=value` | 定点改字段（可重复；值按 TOML 解析；数组元素不可寻址；会重排清单格式）。`--open` 在文件管理器定位清单（改完用 update 应用） |
| `jishu-cli plugins enable/disable <id>` | 启停（重启或插件页重载生效） |

**端到端流程**（用户说"帮我加一个插件"）：

1. 读第一层判断形态 → 2. 复制第二层模板填空 → 3.（混合式）对照第三层 API
   → 4. 过第四层陷阱 → 5. `plugins validate` 校验 → 6. `plugins add` /
   `add-hybrid` 安装 → 7. 告知用户：hub 界面确认卡点「启用」后生效。
