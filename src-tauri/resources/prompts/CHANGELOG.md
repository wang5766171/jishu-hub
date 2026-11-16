# 内部提示词版本台账

话术正文存放本目录（一文件一话术，`{{占位符}}` 由注入方代码填充），版本登记在
`src-tauri/src/agent/internal_prompts.rs` 的 `PROMPT_*` 常量。

**改话术的流程**：改文件 + 版本号 +1 + 此处追加一行变更记录。
注入标记对（`<JISHU-TOOL-PLUGINS>` / `<JISHU-MCP-HINT>` / `<JISHU-IMAGE-DISPATCH>` / `<JISHU-EXEC-CONTRACT>`，
v0.9.5 统一大写横线规范）不随话术版本变化——回放剥离按标记匹配，全部
历史版本一并剥净，无需为旧版本保留剥离分支。

## 台账

- 2026-09-30 v1 全量建立（mcp-hint / image-dispatch / tool-header / exec-contract）
  ——话术自 chat.rs / tool_plugin.rs / orchestrator execute.rs 代码内迁出，内容
  逐字不变（exec-contract 同格式换标：[JISHU-PROMT:开始/结束] 配对块前缀 →
  <JISHU-EXEC-CONTRACT> 后缀块）。同日注入位置由用户消息前缀改为后缀追加
  （用户裁决）。
- 2026-09-30 标记格式统一为 `JISHU-` 大写横线（`<JISHU-TOOL-PLUGINS>` /
  `<JISHU-MCP-HINT>` / `<JISHU-IMAGE-DISPATCH>` / `<JISHU-EXEC-CONTRACT>`，与
  `[JISHU-TASK:` 同族）；历史格式（小写连字符标记、legacy 纯行/配对块）剥离
  兼容按用户裁决整体移除。
- 2026-10-01 mcp-section v1 全量建立（三轮评审 C15）：工具块内 MCP 服务小节
  正文自 tool_plugin.rs 代码内迁出（内容随迁修正「为名干」笔误 →「名字以
  `{}__` 为前缀的」）；占位符 {{display_name}}/{{plugin_id}}。
- 2026-09-30 mcp-hint v2：注册名描述如实化（「已注册的 `插件id__` 前缀工具
  可直接调用」在 pi 侧与实际注册名 `jishu-hub_插件id__工具` 不符——同日识图
  实测 Tool not found 即此因；改为「以 hub_mcp_list 返回的名称为准，不要
  自行拼接猜测」）。同日识图路由配套：点名的识图工具改用 pi 可见名并内联
  参数 schema（image-dispatch 模板骨架未动，仍 v1——子句在 chat.rs 代码侧
  合成）。
- 2026-09-30 识图路由默认不点名（用户裁决）：「mcp 识图工具」配置为空 →
  空集，发现交给 agent 经 mcp 搜索 / hub_mcp_list 列表自选；插件 manifest
  的 vision_tools 声明降级为显式配置的短名补全字典，不再自动全量点名
  （原「声明全集」回退 = 隐性绑定具体识图插件，其他用户未必使用）。

## 各话术占位符

| 话术 | 版本 | 占位符 | 填充方 |
| --- | --- | --- | --- |
| mcp-hint | 2 | （无） | tool_plugin::render_hub_mcp_resolver_hint |
| image-dispatch | 1 | `{{mcp_clause}}`、`{{subagent_model_note}}` | chat.rs compose_image_dispatch_hint（按识图路由解析结果） |
| tool-header | 1 | （无） | tool_plugin::render_tool_block（各工具小节动态渲染） |
| exec-contract | 1 | `{{read_files}}`、`{{write_files}}`、`{{run_commands}}`、`{{access_network}}`、`{{deploy}}` | orchestrator execute.rs agent_prompt_with_policy（按节点 permission_scope） |
| mcp-section | 1 | `{{display_name}}`、`{{plugin_id}}` | tool_plugin::render_tool_block（选中 MCP 插件小节，三轮评审 C15 迁入） |

> image-dispatch 的自定义话术（识图路由插件 `session.image-dispatch` 配置）为
> 用户数据，不入本台账。
