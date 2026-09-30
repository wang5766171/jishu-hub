//! 内部提示词统一管理（v0.9.5 重构）：注入标记对、话术版本登记、回放剥离
//! 的唯一真相源（DEVELOP_READ.MD §16.8「标记正则单源」的宿主）。
//!
//! 三类会话注入块（标记对包裹，agent 可见、展示面剥离；注入形态为用户消息的
//! **后缀**追加）：
//! - `<JISHU-TOOL-PLUGINS>`   工具插件说明（v0.8.1 需求7）
//! - `<JISHU-MCP-HINT>`       MCP 解析服务提示（v0.9.1 需求12）
//! - `<JISHU-IMAGE-DISPATCH>` 图片识图路由（v0.9.5 需求2/T9）
//!
//! 另有一类节点级注入块（orchestrator 执行契约，同为用户消息后缀）：
//! - `<JISHU-EXEC-CONTRACT>`  任务节点 permission_scope 硬契约（v0.9.5 格式
//!   统一时自 `[JISHU-PROMT:开始/结束]` 配对块前缀换标，旧格式不剥）
//!
//! 标记命名规范（用户裁决 2026-09-30）：`JISHU-` 前缀 + 大写横线，尖括号
//! 标签形态；**不做历史格式兼容**（旧小写连字符标记与 legacy 纯行/配对块
//! 前缀不剥，版本级裁决）。
//!
//! 话术正文存 `resources/prompts/`（一文件一话术，`{{占位符}}` 由注入方填充），
//! 版本登记于下方 `PROMPT_*` 常量，变更台账见该目录 `CHANGELOG.md`。注入标记对
//! 不随话术版本变化——回放剥离按标记匹配，全部历史版本一并剥净。
//!
//! 剥离消费方（消息载荷面，全经本模块、无第二条剥离路径）：commands/sessions.rs
//! （get_session_messages 统一剥离）、session.rs（manifest agent 会话与摘要）、
//! jishu_self/session_title.rs（标题派生）、pi_session.rs（会话列表摘要）。

// ---------------------------------------------------------------------------
// 注入标记对（agent 可见、展示面剥离；JISHU- 大写横线规范）
// ---------------------------------------------------------------------------

pub const TOOL_BLOCK_OPEN: &str = "<JISHU-TOOL-PLUGINS>";
pub const TOOL_BLOCK_CLOSE: &str = "</JISHU-TOOL-PLUGINS>";
pub const MCP_HINT_OPEN: &str = "<JISHU-MCP-HINT>";
pub const MCP_HINT_CLOSE: &str = "</JISHU-MCP-HINT>";
pub const IMAGE_DISPATCH_OPEN: &str = "<JISHU-IMAGE-DISPATCH>";
pub const IMAGE_DISPATCH_CLOSE: &str = "</JISHU-IMAGE-DISPATCH>";
pub const EXEC_CONTRACT_OPEN: &str = "<JISHU-EXEC-CONTRACT>";
pub const EXEC_CONTRACT_CLOSE: &str = "</JISHU-EXEC-CONTRACT>";

// ---------------------------------------------------------------------------
// 话术版本登记（resources/prompts/，台账见该目录 CHANGELOG.md）
// ---------------------------------------------------------------------------

/// 单条内部提示词：body 为标记对内的正文（不含标记本身），占位符由注入方填充。
pub struct VersionedPrompt {
    pub id: &'static str,
    pub version: u32,
    body: &'static str,
}

impl VersionedPrompt {
    /// 正文（尾随空白与 CRLF 归一——include_str! 原样嵌入文件字节，跨平台
    /// checkout 差异在此抹平）。
    pub fn body(&self) -> String {
        self.body.trim_end().replace("\r\n", "\n")
    }
}

/// MCP 解析服务提示正文（v2：注册名描述如实化——各运行时前缀不同，以
/// hub_mcp_list 返回名为准，不引导拼接 `插件id__` 前缀；v1 该句在 pi 侧
/// 与实际注册名 `jishu-hub_插件id__工具` 不符，实测诱发 Tool not found）。
pub const PROMPT_MCP_HINT: VersionedPrompt = VersionedPrompt {
    id: "mcp-hint",
    version: 2,
    body: include_str!("../../resources/prompts/mcp-hint.md"),
};

/// 图片识图路由默认话术（v1）。占位符由 chat.rs compose_image_dispatch_hint
/// 按路由解析结果填充：`{{mcp_clause}}`（识图工具指引）、
/// `{{subagent_model_note}}`（识图模型参数说明，可为空）。
/// 自定义话术（识图路由插件 session.image-dispatch 配置）为用户数据，不入登记。
pub const PROMPT_IMAGE_DISPATCH: VersionedPrompt = VersionedPrompt {
    id: "image-dispatch",
    version: 1,
    body: include_str!("../../resources/prompts/image-dispatch.md"),
};

/// 工具插件注入块头部说明（v1）——各工具小节由 tool_plugin::render_tool_block
/// 按会话启用清单动态渲染。
pub const PROMPT_TOOL_HEADER: VersionedPrompt = VersionedPrompt {
    id: "tool-header",
    version: 1,
    body: include_str!("../../resources/prompts/tool-header.md"),
};

/// orchestrator 节点执行契约正文（v1）。占位符由 orchestrator 引擎
/// （execute.rs agent_prompt_with_policy）按节点 permission_scope 填充：
/// `{{read_files}}` / `{{write_files}}` / `{{run_commands}}` /
/// `{{access_network}}` / `{{deploy}}`。剥离时标记与契约正文一并移除
/// （机器契约，非话术展示）。
pub const PROMPT_EXEC_CONTRACT: VersionedPrompt = VersionedPrompt {
    id: "exec-contract",
    version: 1,
    body: include_str!("../../resources/prompts/exec-contract.md"),
};

// ---------------------------------------------------------------------------
// 回放剥离链（消息载荷面唯一入口）
// ---------------------------------------------------------------------------

/// 剥离全部内部提示词注入块。无标记时原样返回；幂等。
/// 不做历史格式兼容（用户裁决 2026-09-30）：旧小写连字符标记、legacy
/// `[图片处理]` 行前缀与 `[JISHU-PROMT]` 配对块不再剥。
pub fn strip_internal_prompts(text: &str) -> String {
    strip_image_dispatch_block(&strip_mcp_hint_block(&strip_plugins_block(
        &strip_exec_contract_block(text),
    )))
}

/// 回放派生（v0.9.0 需求3 方案 C）：剥全部注入块 + 从工具块 `## <id> — <desc>`
/// 头提取本条消息的工具 id 快照。注入块随 compose 后 prompt 持久化进各家原生
/// JSONL，是每条消息工具快照的唯一保真来源。无工具块时其余注入块照剥。
pub fn extract_tool_snapshot(text: &str) -> (String, Vec<String>) {
    let Some(start) = text.find(TOOL_BLOCK_OPEN) else {
        return (strip_internal_prompts(text), Vec::new());
    };
    let mut ids: Vec<String> = Vec::new();
    if let Some(end_rel) = text[start..].find(TOOL_BLOCK_CLOSE) {
        let block = &text[start..start + end_rel];
        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("## ") {
                if let Some((id, _)) = rest.split_once(" — ") {
                    let id = id.trim();
                    if !id.is_empty() && !ids.iter().any(|x| x == id) {
                        ids.push(id.to_string());
                    }
                }
            }
        }
    }
    (strip_internal_prompts(text), ids)
}

/// 剥离 <JISHU-EXEC-CONTRACT>…</JISHU-EXEC-CONTRACT>（orchestrator 节点执行
/// 契约）：标记与契约正文一并移除（机器契约，正文不展示）。
fn strip_exec_contract_block(text: &str) -> String {
    let Some(start) = text.find(EXEC_CONTRACT_OPEN) else {
        return text.to_string();
    };
    let mut result = String::new();
    let prefix = &text[..start];
    if !prefix.trim().is_empty() {
        result.push_str(prefix);
    }
    if let Some(end_rel) = text[start..].find(EXEC_CONTRACT_CLOSE) {
        let after = &text[start + end_rel + EXEC_CONTRACT_CLOSE.len()..];
        result.push_str(after.trim_start_matches(['\r', '\n']));
    }
    result.trim_end().to_string()
}

/// 剥离 <JISHU-TOOL-PLUGINS>…</JISHU-TOOL-PLUGINS>（工具插件注入块）。
fn strip_plugins_block(text: &str) -> String {
    let Some(start) = text.find(TOOL_BLOCK_OPEN) else {
        return text.to_string();
    };
    let mut result = String::new();
    result.push_str(&text[..start]);
    if let Some(end_rel) = text[start..].find(TOOL_BLOCK_CLOSE) {
        let after = &text[start + end_rel + TOOL_BLOCK_CLOSE.len()..];
        // 块与消息之间的分隔空行（含 CRLF 序列）一并吃掉，避免残留空行。
        result.push_str(after.trim_start_matches(['\r', '\n']));
    } else {
        // 未闭合（异常半写）：丢弃其后内容，保守清理。
    }
    // 剥离后的尾部空白（块在末尾时——后缀注入形态）。
    result.trim_end().to_string()
}

/// 剥离 <JISHU-MCP-HINT>…</JISHU-MCP-HINT>（MCP 解析服务提示，展示面不可见）。
/// 标记前的纯空白前缀与标记后的换行分隔一并清理，避免剥后残留空行。
fn strip_mcp_hint_block(text: &str) -> String {
    let Some(start) = text.find(MCP_HINT_OPEN) else {
        return text.to_string();
    };
    let mut result = String::new();
    let prefix = &text[..start];
    if !prefix.trim().is_empty() {
        result.push_str(prefix);
    }
    if let Some(end_rel) = text[start..].find(MCP_HINT_CLOSE) {
        let after = &text[start + end_rel + MCP_HINT_CLOSE.len()..];
        result.push_str(after.trim_start_matches(['\r', '\n']));
    }
    result.trim_end().to_string()
}

/// 剥离 <JISHU-IMAGE-DISPATCH>…</JISHU-IMAGE-DISPATCH>（图片委派提示，展示面不可见）。
fn strip_image_dispatch_block(text: &str) -> String {
    let Some(start) = text.find(IMAGE_DISPATCH_OPEN) else {
        return text.to_string();
    };
    let mut result = String::new();
    let prefix = &text[..start];
    if !prefix.trim().is_empty() {
        result.push_str(prefix);
    }
    if let Some(end_rel) = text[start..].find(IMAGE_DISPATCH_CLOSE) {
        let after = &text[start + end_rel + IMAGE_DISPATCH_CLOSE.len()..];
        result.push_str(after.trim_start_matches(['\r', '\n']));
    }
    result.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dispatch(body: &str) -> String {
        format!("{IMAGE_DISPATCH_OPEN}{body}{IMAGE_DISPATCH_CLOSE}")
    }

    fn mcp(body: &str) -> String {
        format!("{MCP_HINT_OPEN}\n{body}\n{MCP_HINT_CLOSE}")
    }

    fn tool_block(ids: &[(&str, &str)]) -> String {
        let mut out = format!("{TOOL_BLOCK_OPEN}\n");
        for (id, desc) in ids {
            out.push_str(&format!("\n## {id} — {desc}\n用法: {id} run\n"));
        }
        out.push_str(TOOL_BLOCK_CLOSE);
        out
    }

    // ── 登记健全性：正文非空、占位符在位、标记不得混入正文 ──

    #[test]
    fn registry_bodies_sane() {
        for prompt in [
            &PROMPT_MCP_HINT,
            &PROMPT_IMAGE_DISPATCH,
            &PROMPT_TOOL_HEADER,
            &PROMPT_EXEC_CONTRACT,
        ] {
            let body = prompt.body();
            assert!(!body.trim().is_empty(), "{} 正文为空", prompt.id);
            for marker in [
                TOOL_BLOCK_OPEN,
                MCP_HINT_OPEN,
                IMAGE_DISPATCH_OPEN,
                EXEC_CONTRACT_OPEN,
            ] {
                assert!(!body.contains(marker), "{} 正文混入标记 {}", prompt.id, marker);
            }
            assert!(!body.contains("\r"), "{} 正文含 CR（归一失效）", prompt.id);
        }
        let dispatch_body = PROMPT_IMAGE_DISPATCH.body();
        assert!(dispatch_body.contains("{{mcp_clause}}"), "缺 {{mcp_clause}} 占位符");
        assert!(
            dispatch_body.contains("{{subagent_model_note}}"),
            "缺 {{subagent_model_note}} 占位符"
        );
        assert!(PROMPT_MCP_HINT.body().contains("## jishu-hub — MCP 解析服务"));
        let contract = PROMPT_EXEC_CONTRACT.body();
        for ph in ["{{read_files}}", "{{write_files}}", "{{run_commands}}", "{{access_network}}", "{{deploy}}"] {
            assert!(contract.contains(ph), "执行契约缺占位符 {ph}");
        }
    }

    // ── 新后缀注入形态（v0.9.5 起：用户消息在前，注入块追加在后）──

    #[test]
    fn strips_suffix_dispatch_only() {
        let injected = format!("帮我看图\n{}", dispatch("识图路由话术"));
        assert_eq!(strip_internal_prompts(&injected), "帮我看图");
        let (clean, ids) = extract_tool_snapshot(&injected);
        assert_eq!(clean, "帮我看图");
        assert!(ids.is_empty());
    }

    #[test]
    fn strips_suffix_dispatch_then_mcp() {
        // compose_tool_message 真实后缀顺序：消息 → 图片派发 → MCP 提示
        let injected = format!("帮我看图\n{}\n\n{}", dispatch("话术"), mcp("MCP 提示"));
        assert_eq!(strip_internal_prompts(&injected), "帮我看图");
    }

    #[test]
    fn strips_suffix_dispatch_then_tool_block() {
        let block = tool_block(&[("gh", "GitHub CLI")]);
        let injected = format!("帮我看图\n{}\n\n{}", dispatch("话术"), block);
        let (clean, ids) = extract_tool_snapshot(&injected);
        assert_eq!(clean, "帮我看图");
        assert_eq!(ids, vec!["gh".to_string()]);
    }

    #[test]
    fn strips_suffix_mcp_only() {
        let injected = format!("普通消息\n\n{}", mcp("MCP 提示"));
        assert_eq!(strip_internal_prompts(&injected), "普通消息");
    }

    #[test]
    fn strips_suffix_exec_contract_with_body() {
        // orchestrator 节点消息：正文在前（execute.rs 后缀注入），契约标记与
        // 契约正文一并剥净。
        let injected = format!(
            "实现登录页面\n\n{}Task Orchestrator execution contract:\n- read_files: true\n{}",
            EXEC_CONTRACT_OPEN, EXEC_CONTRACT_CLOSE
        );
        assert_eq!(strip_internal_prompts(&injected), "实现登录页面");
        let (clean, ids) = extract_tool_snapshot(&injected);
        assert_eq!(clean, "实现登录页面");
        assert!(ids.is_empty());
    }

    // ── 旧格式不兼容裁决（用户裁决 2026-09-30）：小写连字符标记与 legacy
    //    纯行/配对块不剥，原样返回 ──

    #[test]
    fn legacy_formats_are_not_stripped() {
        // v0.9.5 重构前的旧小写标记：按版本级裁决不兼容，原样保留。
        let old = "<jishu-image-dispatch>话术</jishu-image-dispatch>\n帮我看图";
        assert_eq!(strip_internal_prompts(old), old);
        // legacy [图片处理] 行 / [JISHU-PROMT] 配对块：同理不剥。
        assert_eq!(strip_internal_prompts("[图片处理] 提示\n正文"), "[图片处理] 提示\n正文");
        assert_eq!(
            strip_internal_prompts("[JISHU-PROMT:开始]\n契约\n[JISHU-PROMT:结束]\n\n正文"),
            "[JISHU-PROMT:开始]\n契约\n[JISHU-PROMT:结束]\n\n正文"
        );
    }

    // ── 快照派生与通用性质 ──

    #[test]
    fn extract_snapshot_no_block_passthrough() {
        assert_eq!(strip_internal_prompts("普通消息"), "普通消息");
        let (clean, ids) = extract_tool_snapshot("hello");
        assert_eq!(clean, "hello");
        assert!(ids.is_empty());
    }

    #[test]
    fn extract_snapshot_dedup_keeps_order() {
        let block = tool_block(&[("a", "A"), ("b", "B"), ("a", "A 重复")]);
        let (clean, ids) = extract_tool_snapshot(&format!("{block}\n\nmsg"));
        assert_eq!(clean, "msg");
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn extract_snapshot_unclosed_tool_block_drops_tail() {
        let broken = format!("msg\n{TOOL_BLOCK_OPEN}\nbroken");
        assert_eq!(strip_internal_prompts(&broken), "msg");
    }

    #[test]
    fn strip_is_idempotent_and_handles_crlf() {
        let block = tool_block(&[("a", "A")]);
        let suffix = format!("hi\r\n\r\n{block}");
        let once = strip_internal_prompts(&suffix);
        assert_eq!(once, "hi");
        assert_eq!(strip_internal_prompts(&once), once);
    }
}
