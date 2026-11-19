# hub 页面能力清单（GUI 适配参考——浓缩版）

> v0.9.8 需求4 一次性参考文档：为「GUI 适配」（装后引导卡 → 会话创建适配件）提供 hub 页面能力的浓缩契约描述。
> 权威源：`DEVELOP_READ.MD` §16.9（挂载位九类）/ §16.12（渲染键）；本文件为面向 agent 的摘录，随架构演进以权威源为准同步。

## 挂载位九类（plugin.toml [render].mount 取值）

| 挂载位 | mount 值 | 适用形态 | 说明 |
|---|---|---|---|
| 停靠面板 | `dock-panel` | 组合件（source=messages/turns/task） | 右侧停靠内容面板（如会话大纲） |
| 侧栏面板 | `sidebar` | 组合件（source=messages/turns/task） | 会话侧栏内的面板区 |
| 会话栏挂件 | `rail` | 组合件（source=stream-state/messages） | 会话流左缘挂件（如导航列） |
| 输入框尾挂件 | `composer` | 组合件（source=stream-state） | 输入框尾部小挂件（模式开关类） |
| 消息内块渲染器 | `block-renderer` | 纯 TOML 或组合件（source=messages） | 按代码块语言/内容类型命中替换渲染（图表/HTML/mermaid 等） |
| 流内卡 | `stream-card` | 组合件（source=messages/turns） | 流内插入卡片（任务看板、成果卡类） |
| 标题栏动作 | `titlebar-action` | 组合件 | 标题栏按钮型动作入口 |
| 设置页 | `settings-page` | 组合件 | 管理页独立设置面板 |
| 独立面板 | `panel` | 组合件 | 独立页面（从标题栏/菜单进入） |

## 选型口诀

- 有**周期性/流式数据**要常看 → dock-panel / sidebar
- 只在**特定消息内容**上增强呈现 → block-renderer
- **轻量开关/状态** → rail / composer
- **一次性动作** → titlebar-action

## 渲染键（[render] 其他字段）

- 纯 TOML 件：`render.list` 等内置渲染器键（零代码）。
- 混合件（组合件）：`render.component = "@file:component.js"`，组件形状 `JishuPlugin.register(id, { version, component: (api) => (props) => api.h(...) })`（双箭头，非 mount(el, ctx)）。
- 主题件：`kind = "composed-theme"`，声明配色/CSS 变量覆盖。

## 产出流程（适配插件从产到用）

描述需求（本清单所在引导链预填草稿）→ agent 开发 → `jishu-cli plugins add-hybrid <目录>` 或经确认卡安装 → 确认卡（默认禁用+确认启用安全阀）→ 插件中心可见可用（聚光）。

## 扩展探查建议

对 pi 扩展（npm 包）先探查公开 API 与数据形态：读包的 package.json/README/导出符号（可用 pi-lens 按符号找代码），确定「哪个能力 × 哪个挂载位」再动手。
