# 插件开放能力参考（API Reference）

> 二十三轮（2026-11-15 用户裁决）：插件能力面开放——本文是**唯一权威清单**。
> agent 创建插件前必读；`jishu-cli plugins api` 打印本文件全文。
> 契约版本：PLUGIN_API_VERSION 1（`JishuPlugin.register` 的 version 字段）。

## 一、组件工厂 `api`（第一个参数——造界面的工具箱）

| 成员 | 说明 |
|---|---|
| `h` | 渲染元素（hyperscript） |
| `useState / useEffect / useMemo / useRef / useCallback` | React hooks 全套 |
| `t(key, fallback)` | 多语言文案 |
| `cn(...)` | 样式类名合并 |
| `loadAsset(rel, kind?)` | 从插件目录注入资产（script/style/url）——echarts 等库的引入通道；资产必须平铺在插件根目录 |
| `fetch` | **网络直通**（二十三轮裁决免管控）——CSP 已放开外部域，可直接请求任意 API |

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

全部异步（Promise）；只读 + openUrl——无写面（重命名/删除/持久化不开放）。

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
    .catch((e) => api.console?.error?.(e));
}, []);
```
