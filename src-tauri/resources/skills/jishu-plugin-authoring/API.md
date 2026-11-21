# 插件开放能力参考（API Reference）

> 二十三轮（2026-11-15 用户裁决）：插件能力面开放——本文是**唯一权威清单**。
> agent 创建插件前必读；`jishu-cli plugins api` 打印本文件全文。
> 契约版本：PLUGIN_API_VERSION 1（`JishuPlugin.register` 的 version 字段）。
> 开放策略（2026-11-15 二十四轮裁决）：pi 智能体能力**逐步明确开放**——本文即
> 契约承诺面；未列入者不承诺（技术上可能可达但不属于契约）。

## 一、组件工厂 `api`（第一个参数——造界面的工具箱）

| 成员 | 说明 |
|---|---|
| `h` | 渲染元素（hyperscript） |
| `useState / useEffect / useMemo / useRef / useCallback` | React hooks 全套 |
| `t(key, fallback)` | 多语言文案 |
| `cn(...)` | 样式类名合并 |
| `loadAsset(rel, kind?)` | 从插件目录注入资产（script/style/url）——echarts 等库的引入通道；资产必须平铺在插件根目录 |
| `fetch` | **网络直通**（二十三轮裁决免管控）——CSP 已放开外部域（http/https 及其上的 ws/wss 均直通），可直接请求任意 API |

## 二、组件 `props`

| 成员 | 说明 |
|---|---|
| `props.ctx` | 会话内核上下文（见三/四） |
| `props.payload` | 清单 `[source]` 声明的聚合数据（messages/turns/task/signal） |

## 三、`ctx` 当前会话能力（快照 + 命令 + 订阅）

**数据快照**：`turns`（轮次摘要，含每轮花销 cost）、`activeTurnIndex`、`sessionId/sessionTitle`、`messages`（完整消息投影）、`approvals`（待审批面）、`streamState`（流式状态）、`sessionMeta`（agent/模型/上下文占用/项目编码名）、`task`（任务上下文）、`projectPath`。

**命令**：`scrollToTurn(i)`、`searchMessages(q)`、`scrollToMessage(i)`、`insertToComposer(text)`（插入输入框不发送）、`switchSession(id)`（切换会话）、`openFileViewer(path)`、`openPanel(pluginId)/closePanel()`（展开自己的面板）、`compactSession()/isCompacting`、`capabilities`、`autoCompaction/setAutoCompaction`、`devLog(msg, data?)`、`confirmDialog(opts)`、`resolveSessionInfo(id)`。

**订阅**（声明制，注册即回放）：`subscribe.messages/streamState/sessionMeta/turns/approvals/events`。

## 四、`ctx.hub` 全局能力（二十三轮新增——跨会话/项目只读面）

| 方法 | 返回 | 说明 |
|---|---|---|
| `hub.listSessions(opts?)` | `HubSessionSummary[]`：`{ id, title, agentId, projectPath, startedAt, lastActive, messageCount, totalCost, toolCallsTotal }` | 会话列表；默认**跨全部项目**，可传 `{ projectEncodedName }` 限定单项目；标题已合并 ai-title 与用户重命名；花销/工具调用为 usage.db 精确记账 |
| `hub.sessionStats(sessionId?)` | `{ sessionId, messageCount, turnCount, toolCalls: Record<工具名, 次数>, totalCost, toolCallsTotal }` | 会话统计；默认当前会话；消息级聚合（工具分布/轮数）限当前项目内会话，用量面跨项目可用 |
| `hub.listProjects()` | `{ name, path }[]` | 项目列表 |
| `hub.listAgents()` | `{ id, displayName, installed }[]` | 已装智能体 |
| `hub.openUrl(url)` | void | 系统默认浏览器打开外部链接 |

全部异步（Promise）；只读 + openUrl——重命名/删除/持久化不开放。

## 四b、`ctx.hub.agent` pi 智能体定制面（二十四轮——插件可自由定制 pi）

| 方法 | 说明 |
|---|---|
| `agent.sendMessage({ message, sessionId?, projectPath? })` | **发消息驱动智能体**：不传 sessionId = 新建会话；返回 `{ sessionId }`（新建时可拿到 id） |
| `agent.steer({ sessionId, message })` | 中途引导当前回合（注入不起新轮——排队消息同款语义） |
| `agent.abort(sessionId)` | 中止指定会话的当前回合 |
| `agent.models()` | 可选模型清单 `{ value, label }[]` |
| `agent.getModel(sessionId)` / `agent.setModel({ sessionId, provider, model })` | 会话锁定模型读写（model 空串 = 清除回落全局）；**sessionId 须为真实会话 id**（sendMessage 新建返回的 `pending-*` 为 GUI 临时 id，回合完成转真实 id 后方可用于模型锁定——经 hub.listSessions 可查） |

经此六法插件可构建：自动化工作台（发任务+跟踪）、会话驾驶舱（中止/引导）、模型切换器等定制面。

## 四c、开放路线图（二十四轮用户裁决「逐步明确开放 pi 能力」）

- **P0 已开放**：上文全部（api 工具箱/fetch/ctx 会话面/ctx.hub 数据面/agent 定制面）
- **P1 候补（通道现成，按需启用）**：全局用量总览与轮次级明细（usage_overview/segment——花销趋势图）、pi RPC 闲置读面（get_messages/get_entries/get_tree/get_session_stats/get_commands）、交互请求回写（extension_ui_response）、审批应答、fork 会话、自动压缩开关、任务图读面
- **P2 候补（需契约设计）**：权限/工具模式切换、排队模式、自动重试、会话命名/导出、子代理与任务写面、skill 分发触发
- **边界（不开放/需用户级确认）**：任意 shell（pi bash）、绕过 hub 的模型热切（set_model——破坏记账/签名一致性）、凭据重路由（registerProvider）、pi 扩展导入与包安装（任意代码执行）、MCP/skill 全局注入、丢排队消息（clear_queue）

## 五、示例：会话列表数据页（menu 挂载 + hub 能力）

```js
JishuPlugin.register("session.sessions-page", {
  version: 1,
  component: (api) => (props) => {
    const [rows, setRows] = api.useState(null);
    api.useEffect(() => {
      props.ctx.hub.listSessions().then(setRows);
    }, []);
    if (!rows) return api.h("p", null, "加载中…");
    return api.h("table", { className: "w-full text-xs" },
      api.h("thead", null, api.h("tr", null,
        ["会话", "消息数", "工具调用", "花销"].map((t) => api.h("th", { key: t, className: "text-left" }, t)))),
      api.h("tbody", null, rows.map((r) => api.h("tr", { key: r.id, onClick: () => props.ctx.switchSession(r.id), className: "cursor-pointer hover:bg-accent" },
        api.h("td", null, r.title ?? r.id.slice(0, 12)),
        api.h("td", null, String(r.messageCount)),
        api.h("td", null, r.toolCallsTotal == null ? "—" : String(r.toolCallsTotal)),
        api.h("td", null, r.totalCost == null ? "—" : "¥" + r.totalCost.toFixed(4))))));
  },
});
```

外部 API（`api.fetch` 示例）：

```js
api.useEffect(() => {
  api.fetch("https://api.github.com/repos/owner/repo")
    .then((r) => r.json())
    .then(setData)
    .catch((e) => setData(null)); // api 无 console——错误请渲染进组件或静默降级
}, []);
```

## 六、挂载与 payload 契约（需求4 F2，2026-11-21——每类挂载递给组件什么数据）

> 本节回答适配开发最关键的问题：「我的组件能拿到什么」。锚定测试
> `src/components/observability/tool-call-card/bodies/other-payload.test.tsx`
> 锁实现不漂移；改动 payload 形状必须先改本节（契约先行）。

### tool-output 挂载（认领工具结果渲染）

组件经 `[source] tool_name/tool_pattern` 认领工具后，该工具的消息内结果卡
由你的组件替换渲染，收到 payload：

| 字段 | 类型 | 语义 |
|---|---|---|
| `kind` | `"tool-result"` | 恒定 |
| `toolName` | string | 工具名（如 `web_fetch`） |
| `output` | string | 工具输出的**文本**（hub 归一化后） |
| `input` | object（可选） | 工具**入参**（如 `{ url }`）——入参非空时携带 |
| `details` | object（可选） | 工具结果的**结构化元数据**（如 web_fetch 的 `title/published/wordCount/contentType`）——工具提供 details 且非空时携带；直播与回放双路可得 |

要点：需要网页标题/发布时间等元数据时**直接读 `payload.details`**，不要
解析 `output` 文本（文本格式非契约，随时可变）。

### block-renderer 挂载（代码块/块类型命中）

| payload | 语义 |
|---|---|
| `{ kind: "code-block", language, code }` | 按语言命中（`[source] languages`） |
| `{ kind: "block", blockType, block }` | 按内容块类型命中 |

### 其余挂载（dock-panel/sidebar/rail/composer/menu/stream-card/titlebar-action/settings-page/panel/event-hook）

payload = 清单 `[source]` 声明的聚合数据（messages/turns/task/signal，
见 hub-page-capabilities.md「渲染键」）；无 tool-result 型 payload。

### `[[adapt]]` 段（适配关系声明——需求4 D4-8）

为**独立安装的 pi 扩展**做 GUI 适配的插件，在 plugin.toml 顶层声明（数组，
一条一个扩展；`extension` 用**不带版本**的关系键，扩展升级不断链）：

```toml
[[adapt]]
extension = "npm:pi-smart-fetch"      # 被适配扩展（无版本键）
tools = ["web_fetch", "batch_web_fetch"]  # 可选：声明消费哪些工具；省略=整个扩展
```

声明后 hub 的扩展登记簿自动建立关系：扩展卡显示「界面：由本插件呈现」；
**扩展停用/卸载时本插件自动联动停用**（数据来源断供即停，恢复时自动回来）；
一个扩展可被多个插件适配（不同视角）、一个插件也可声明多条 `[[adapt]]`
（整合多个扩展）。`jishu-cli extensions list` 可查登记簿现况。
