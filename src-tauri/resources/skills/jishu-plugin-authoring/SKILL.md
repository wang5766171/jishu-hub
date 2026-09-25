---
name: jishu-plugin-authoring
description: 创建/安装 Jishu Hub 插件前必读——四层指南：①判断指南（用户想要什么 → 该造哪种插件：智能体工具/会话界面组合式/混合代码/流水线/自建智能体/MCP/Skill）；②六形态可复制模板（plugin.toml + component.js 完整示例）；③混合插件 component.js API 参考（JishuPlugin.register/h/useState/props 形状）；④陷阱与最佳实践。配套 CLI：plugins add（统一寻址）/ validate / add-hybrid。用户说"加一个插件/让 AI 能 X/在会话里显示 X"时按本指南产出并安装。
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
│   └─ 多阶段工作流（讨论→设计→执行）？ → 流水线（[[pipeline.stages]]）
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

**混合式限制**：@file: 代码组件只支持数据面挂载（dock/rail/sidebar/composer），
不支持 block-renderer；不支持 export-file 动作。

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

[info]
id = "gemini-cli"
name = "Gemini CLI"
description = "Google Gemini 命令行智能体"
kind = "agent"
icon = "gemini"

[transport]
command = "gemini"
args = ["-m", "gemini-2.5-pro"]
```

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

组件 props 形状：

```ts
{
  payload: // 源数据，按 [source].type 定形状：
    //   messages → { kind: "aggregate", data: Message[] }（可配聚合器）
    //   turns    → { kind: "turns", turns: TurnInfo[], activeIndex, jump(i) }
    //   task     → { kind: "task", task: TaskInfo }
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

## 安装与管理命令速查

| 命令 | 说明 |
|---|---|
| `jishu-cli plugins add <toml 或目录>` | 统一寻址：内容含 [plugin].id → 组合式/流水线（落 plugins/）；含 [info] → 智能体/工具（落 agents/） |
| `jishu-cli plugins add-hybrid <目录>` | 混合插件目录包（plugin.toml + component.js） |
| `jishu-cli plugins validate <目录或 toml>` | 校验不安装（hub 运行中 = GUI 同款校验器） |
| `jishu-cli plugins list` / `get <id>` / `update <id> <toml>` / `remove <id>` | 管理（get/update/remove 双落点统一寻址） |
| `jishu-cli plugins enable/disable <id>` | 启停（重启或插件页重载生效） |

**端到端流程**（用户说"帮我加一个插件"）：

1. 读第一层判断形态 → 2. 复制第二层模板填空 → 3.（混合式）对照第三层 API
   → 4. 过第四层陷阱 → 5. `plugins validate` 校验 → 6. `plugins add` /
   `add-hybrid` 安装 → 7. 告知用户：hub 界面确认卡点「启用」后生效。
