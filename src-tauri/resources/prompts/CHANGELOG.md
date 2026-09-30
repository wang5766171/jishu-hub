# 内部提示词版本台账

话术正文存放本目录（一文件一话术，`{{占位符}}` 由注入方代码填充），版本登记在
`src-tauri/src/agent/internal_prompts.rs` 的 `PROMPT_*` 常量。

**改话术的流程**：改文件 + 版本号 +1 + 此处追加一行变更记录。
注入标记对（`<jishu-tool-plugins>` / `<jishu-mcp-hint>` / `<jishu-image-dispatch>`）
不随话术版本变化——回放剥离按标记匹配，全部历史版本一并剥净，无需为旧版本保留剥离分支。

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

## 各话术占位符

| 话术 | 版本 | 占位符 | 填充方 |
| --- | --- | --- | --- |
| mcp-hint | 1 | （无） | tool_plugin::render_hub_mcp_resolver_hint |
| image-dispatch | 1 | `{{mcp_clause}}`、`{{subagent_model_note}}` | chat.rs compose_image_dispatch_hint（按识图路由解析结果） |
| tool-header | 1 | （无） | tool_plugin::render_tool_block（各工具小节动态渲染） |
| exec-contract | 1 | `{{read_files}}`、`{{write_files}}`、`{{run_commands}}`、`{{access_network}}`、`{{deploy}}` | orchestrator execute.rs agent_prompt_with_policy（按节点 permission_scope） |

> image-dispatch 的自定义话术（识图路由插件 `session.image-dispatch` 配置）为
> 用户数据，不入本台账。
