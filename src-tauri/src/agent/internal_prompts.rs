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
/// 需求5（v0.9.8 合并版）：装备目录注入块（用户消息后缀；agent 侧装备
/// 推荐的信息供给）。注意：agent 回复中的 `<JISHU-EQUIP-RECOMMEND>` 块
/// 是 **UI 渲染指令**（前端解析成推荐卡），**不在剥离链**——两码事。
pub const EQUIP_CATALOG_OPEN: &str = "<JISHU-EQUIP-CATALOG>";
pub const EQUIP_CATALOG_CLOSE: &str = "</JISHU-EQUIP-CATALOG>";

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
/// 与实际注册名 `mcp__jishu-hub__插件id__工具` 不符，实测诱发 Tool not found；
/// pi 1.1.0 原生 MCP 命名规律，需求11 adapter 退役后统一）。
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
    // v2（需求11 三轮后）：路由判定准则显式化（客观转述→MCP/理解推理→
    // subagent，拿不准倾向分析）——收紧「单图但要求分析」被误判简单识别
    // 走 MCP 的模糊带（用户口径对齐）。
    version: 2,
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

/// 工具块内 MCP 服务小节正文（v1）。占位符由 tool_plugin::render_tool_block
/// 按选中插件填充：`{{display_name}}` / `{{plugin_id}}`。三轮评审 C15：
/// 自 f1a960e 起内联于代码，按话术三件套纪律迁入文件（同批修正「为名干」
/// 笔误 → 「名字以 `{}__` 为前缀的」）。
pub const PROMPT_MCP_SECTION: VersionedPrompt = VersionedPrompt {
    id: "mcp-section",
    version: 1,
    body: include_str!("../../resources/prompts/mcp-section.md"),
};

/// 插件目录注入块正文（需求5 合并版）。占位符由
/// equipment_db::catalog_block 填充：`{{catalog_lines}}`（逐行插件档案）。
/// v3（2026-11-22 用户实测追问）：目录之外**可现查第三方**（SkillHub/
/// 扩展生态，ref 用 skillhub:\<slug\> / pi:\<源\>）——v2 只推目录内清单，
/// agent 被框死在官方 31 件，第三方海量库永远进不了推荐（用户「未装的
/// 扩展也可以推荐」诉求）；v2 话术装备→插件；v1 初版。
pub const PROMPT_EQUIP_CATALOG: VersionedPrompt = VersionedPrompt {
    id: "equip-catalog",
    version: 3,
    body: include_str!("../../resources/prompts/equip-catalog.md"),
};

/// 登记在册的全部内部提示词。启动时的版本锚点日志、登记健全性测试、台账
/// 对账都从这里取——新增话术只改这一处。
///
/// v0.9.8 评审修复轮 R2：此前锚点日志和健全性测试各手抄一份清单，装备目录
/// 话术（equip-catalog）加进来时两处都漏了：锚点少一项、测试少测一个。
pub fn registered_prompts() -> &'static [&'static VersionedPrompt] {
    &[
        &PROMPT_MCP_HINT,
        &PROMPT_IMAGE_DISPATCH,
        &PROMPT_TOOL_HEADER,
        &PROMPT_EXEC_CONTRACT,
        &PROMPT_MCP_SECTION,
        &PROMPT_EQUIP_CATALOG,
    ]
}

/// 版本锚点一行（`<id> v<版本>` 逗号分隔）。启动日志打印它；历史会话剥离
/// 异常时，先核对这一行与 `resources/prompts/CHANGELOG.md` 是否对得上账。
pub fn version_anchor_line() -> String {
    registered_prompts()
        .iter()
        .map(|prompt| format!("{} v{}", prompt.id, prompt.version))
        .collect::<Vec<_>>()
        .join(", ")
}

// ---------------------------------------------------------------------------
// 回放剥离链（消息载荷面唯一入口）
// ---------------------------------------------------------------------------

/// 剥离全部内部提示词注入块。无标记时原样返回；幂等。
/// 不做历史格式兼容（用户裁决 2026-09-30）：旧小写连字符标记、legacy
/// `[图片处理]` 行前缀与 `[JISHU-PROMT]` 配对块不再剥。
pub fn strip_internal_prompts(text: &str) -> String {
    strip_equip_catalog_block(&strip_image_dispatch_block(&strip_mcp_hint_block(
        &strip_plugins_block(&strip_exec_contract_block(text)),
    )))
}

/// 回放派生（v0.9.0 需求3 方案 C）：剥全部注入块 + 从工具块 `## <id> — <desc>`
/// 头提取本条消息的工具 id 快照。注入块随 compose 后 prompt 持久化进各家原生
/// JSONL，是每条消息工具快照的唯一保真来源。无工具块时其余注入块照剥。
///
/// 工具块可能不止一段（引擎取消善期多条缓冲消息拼成一条 prompt，每条各带
/// 一套）：每一段里的工具 id 都取（评审修复轮 R3 / P2-7，此前只看第一段）。
pub fn extract_tool_snapshot(text: &str) -> (String, Vec<String>) {
    let mut ids: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(TOOL_BLOCK_OPEN) {
        let from_open = &rest[start..];
        // 未闭合（异常半写）：后面没有完整的工具块了。
        let Some(end_rel) = from_open.find(TOOL_BLOCK_CLOSE) else {
            break;
        };
        let block = &from_open[..end_rel];
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
        rest = &from_open[end_rel + TOOL_BLOCK_CLOSE.len()..];
    }
    (strip_internal_prompts(text), ids)
}

/// 剥离一对标记之间的注入块（回放不可见的统一实现，五种标记共用）。
///
/// - 块在末尾（后缀注入的常态）：只留标记之前的内容。
/// - 块在中间——引擎取消善期多条缓冲消息拼成一条 prompt，前一条消息的注入块
///   夹在两条消息之间：前后两段之间保留一个空行，它们本来就是两条消息。
///   v0.9.8 评审修复轮 R2：此前把块后面的换行全部吃掉，两段之间只剩下前一段
///   结尾处恰好留下的换行；前一段以单个换行收尾时（图片派发块紧跟消息），
///   剥完两段之间只剩一个换行，回放里连成「第一条第二条」。
/// - 同一种块出现不止一次（同样是缓冲合并的形态，每条消息各带一套后缀）：
///   逐个剥到不再出现（评审修复轮 R3 / P2-7，此前只剥第一个，第二个原样
///   留在回放里）。
/// - 未闭合（异常半写）：丢弃其后内容，保守清理。
///
/// `keep_blank_prefix`：标记之前只有空白时要不要原样保留。工具块自 v0.9.5 起
/// 就是「前缀原样保留」的写法，其余四种一直是不保留；各自既有行为这里不改。
fn strip_block(text: &str, open: &str, close: &str, keep_blank_prefix: bool) -> Option<String> {
    let mut current = text.to_string();
    let mut stripped = false;
    while let Some(next) = strip_first_block(&current, open, close, keep_blank_prefix) {
        current = next;
        stripped = true;
    }
    stripped.then_some(current)
}

/// 剥掉文本里第一个 `open…close` 块；没有起始标记 → None。
fn strip_first_block(
    text: &str,
    open: &str,
    close: &str,
    keep_blank_prefix: bool,
) -> Option<String> {
    let start = text.find(open)?;
    let prefix = &text[..start];
    let mut head = String::new();
    if keep_blank_prefix || !prefix.trim().is_empty() {
        head.push_str(prefix);
    }
    let after = match text[start..].find(close) {
        Some(end_rel) => &text[start + end_rel + close.len()..],
        // 未闭合（异常半写）：丢弃其后内容，保守清理。
        None => "",
    };
    let tail = after.trim_start_matches(['\r', '\n']);
    let result = if tail.is_empty() {
        head
    } else if head.trim().is_empty() {
        if keep_blank_prefix {
            format!("{head}{tail}")
        } else {
            tail.to_string()
        }
    } else if after.starts_with(['\r', '\n']) || head.ends_with(['\r', '\n']) {
        // 块独占一行：前后两段之间保留一个空行。
        format!("{}\n\n{tail}", head.trim_end())
    } else {
        // 块嵌在一行中间（用户手输了标记）：直接拼接。
        format!("{head}{tail}")
    };
    Some(result.trim_end().to_string())
}

/// 剥离 <JISHU-EXEC-CONTRACT>…</JISHU-EXEC-CONTRACT>（orchestrator 节点执行
/// 契约）：标记与契约正文一并移除（机器契约，正文不展示）。
fn strip_exec_contract_block(text: &str) -> String {
    strip_block(text, EXEC_CONTRACT_OPEN, EXEC_CONTRACT_CLOSE, false)
        .unwrap_or_else(|| text.to_string())
}

/// 剥离 <JISHU-TOOL-PLUGINS>…</JISHU-TOOL-PLUGINS>（工具插件注入块）。
fn strip_plugins_block(text: &str) -> String {
    strip_block(text, TOOL_BLOCK_OPEN, TOOL_BLOCK_CLOSE, true).unwrap_or_else(|| text.to_string())
}

/// 剥离 <JISHU-MCP-HINT>…</JISHU-MCP-HINT>（MCP 解析服务提示，展示面不可见）。
fn strip_mcp_hint_block(text: &str) -> String {
    strip_block(text, MCP_HINT_OPEN, MCP_HINT_CLOSE, false).unwrap_or_else(|| text.to_string())
}

/// 剥离 <JISHU-IMAGE-DISPATCH>…</JISHU-IMAGE-DISPATCH>（图片委派提示，展示面不可见）。
fn strip_image_dispatch_block(text: &str) -> String {
    strip_block(text, IMAGE_DISPATCH_OPEN, IMAGE_DISPATCH_CLOSE, false)
        .unwrap_or_else(|| text.to_string())
}

/// 剥离 <JISHU-EQUIP-CATALOG>…</JISHU-EQUIP-CATALOG>（装备目录注入块，
/// 需求5 合并版：agent 信息供给，展示面不可见）。
fn strip_equip_catalog_block(text: &str) -> String {
    strip_block(text, EQUIP_CATALOG_OPEN, EQUIP_CATALOG_CLOSE, false)
        .unwrap_or_else(|| text.to_string())
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
        // v0.9.8 评审修复轮 R2：清单从登记处取（此前手抄一份，漏了 equip-catalog）。
        for prompt in registered_prompts() {
            let body = prompt.body();
            assert!(!body.trim().is_empty(), "{} 正文为空", prompt.id);
            for marker in [
                TOOL_BLOCK_OPEN,
                MCP_HINT_OPEN,
                IMAGE_DISPATCH_OPEN,
                EXEC_CONTRACT_OPEN,
                EQUIP_CATALOG_OPEN,
            ] {
                assert!(
                    !body.contains(marker),
                    "{} 正文混入标记 {}",
                    prompt.id,
                    marker
                );
            }
            assert!(!body.contains("\r"), "{} 正文含 CR（归一失效）", prompt.id);
        }
        let dispatch_body = PROMPT_IMAGE_DISPATCH.body();
        assert!(
            dispatch_body.contains("{{mcp_clause}}"),
            "缺 {{mcp_clause}} 占位符"
        );
        assert!(
            dispatch_body.contains("{{subagent_model_note}}"),
            "缺 {{subagent_model_note}} 占位符"
        );
        assert!(PROMPT_MCP_HINT
            .body()
            .contains("## jishu-hub — MCP 解析服务"));
        let contract = PROMPT_EXEC_CONTRACT.body();
        for ph in [
            "{{read_files}}",
            "{{write_files}}",
            "{{run_commands}}",
            "{{access_network}}",
            "{{deploy}}",
        ] {
            assert!(contract.contains(ph), "执行契约缺占位符 {ph}");
        }
        let mcp_section = PROMPT_MCP_SECTION.body();
        assert!(
            mcp_section.contains("{{display_name}}"),
            "缺 {{display_name}} 占位符"
        );
        assert!(
            mcp_section.contains("{{plugin_id}}"),
            "缺 {{plugin_id}} 占位符"
        );
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
        assert_eq!(
            strip_internal_prompts("[图片处理] 提示\n正文"),
            "[图片处理] 提示\n正文"
        );
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

    // ── v0.9.8 评审修复轮 R2 ──

    /// 注入块夹在两条消息中间（取消善期多条缓冲消息拼成一条 prompt）：剥离后
    /// 两段之间保留一个空行。修前把块后面的换行全部吃掉，前一段以单个换行
    /// 收尾时两段连成「第一条第二条」。五种标记逐个验，紧凑 / 宽松 / CRLF。
    #[test]
    fn block_between_two_messages_keeps_paragraph_break() {
        let blocks = [
            (TOOL_BLOCK_OPEN, tool_block(&[("gh", "GitHub CLI")])),
            (MCP_HINT_OPEN, mcp("MCP 提示")),
            (IMAGE_DISPATCH_OPEN, dispatch("识图路由话术")),
            (
                EXEC_CONTRACT_OPEN,
                format!("{EXEC_CONTRACT_OPEN}契约正文{EXEC_CONTRACT_CLOSE}"),
            ),
            (
                EQUIP_CATALOG_OPEN,
                format!("{EQUIP_CATALOG_OPEN}目录正文{EQUIP_CATALOG_CLOSE}"),
            ),
        ];
        for (open, block) in &blocks {
            let expected = "第一条\n\n第二条";
            let tight = format!("第一条\n{block}\n第二条");
            assert_eq!(
                strip_internal_prompts(&tight),
                expected,
                "块 {open} 夹在中间（紧凑）"
            );
            assert_eq!(extract_tool_snapshot(&tight).0, expected);
            let loose = format!("第一条\n\n{block}\n\n第二条");
            assert_eq!(
                strip_internal_prompts(&loose),
                expected,
                "块 {open} 夹在中间（宽松）"
            );
            let crlf = format!("第一条\r\n{block}\r\n第二条");
            assert_eq!(
                strip_internal_prompts(&crlf),
                expected,
                "块 {open} 夹在中间（CRLF）"
            );
        }
        // 块嵌在一行中间（用户手输了标记）：块本身剥掉、前后直接拼接，不插入空行。
        assert_eq!(
            strip_internal_prompts(&format!("前 {TOOL_BLOCK_OPEN}块{TOOL_BLOCK_CLOSE} 后")),
            "前  后"
        );
    }

    /// 评审修复轮 R3（P2-7）：缓冲合并后每条消息各带一套后缀——同一种块出现
    /// 两次（分别跟在两条消息后面，或挨着排在一起），两处都剥掉，两条消息
    /// 之间保留一个空行。修前只剥第一个，第二个原样留在回放里。
    #[test]
    fn repeated_block_is_stripped_wherever_it_sits() {
        let blocks = [
            (TOOL_BLOCK_OPEN, tool_block(&[("gh", "GitHub CLI")])),
            (MCP_HINT_OPEN, mcp("MCP 提示")),
            (IMAGE_DISPATCH_OPEN, dispatch("识图路由话术")),
            (
                EXEC_CONTRACT_OPEN,
                format!("{EXEC_CONTRACT_OPEN}契约正文{EXEC_CONTRACT_CLOSE}"),
            ),
            (
                EQUIP_CATALOG_OPEN,
                format!("{EQUIP_CATALOG_OPEN}目录正文{EQUIP_CATALOG_CLOSE}"),
            ),
        ];
        for (open, block) in &blocks {
            // 真实形态：第一条消息带后缀块，换行，第二条消息带同一个后缀块。
            let merged = format!("第一条\n\n{block}\n第二条\n\n{block}");
            let stripped = strip_internal_prompts(&merged);
            assert_eq!(stripped, "第一条\n\n第二条", "块 {open} 出现两次");
            assert!(!stripped.contains(open), "块 {open} 不留裸露的标记");
            // 两个块挨在一起（两条消息的后缀排到一处）。
            let adjacent = format!("第一条\n\n{block}\n{block}\n\n第二条");
            assert_eq!(
                strip_internal_prompts(&adjacent),
                "第一条\n\n第二条",
                "块 {open} 挨着出现两次"
            );
            assert_eq!(extract_tool_snapshot(&merged).0, "第一条\n\n第二条");
        }
    }

    /// 评审修复轮 R3（P2-7）：缓冲合并的两条消息各带一段工具块——两段里的
    /// 工具 id 都取到（修前只看第一段）。
    #[test]
    fn tool_ids_are_collected_from_every_block() {
        let first = tool_block(&[("gh", "GitHub CLI")]);
        let second = tool_block(&[("gh", "GitHub CLI"), ("npm:ext-b", "乙扩展")]);
        let (text, ids) = extract_tool_snapshot(&format!("第一条\n\n{first}\n第二条\n\n{second}"));
        assert_eq!(text, "第一条\n\n第二条");
        assert_eq!(
            ids,
            vec!["gh".to_string(), "npm:ext-b".to_string()],
            "第二段里的工具也要取到，重复的不多记"
        );
    }

    /// 版本锚点行列出登记在册的每一个话术（装备目录也在——修前漏掉）。
    #[test]
    fn version_anchor_line_lists_every_registered_prompt() {
        let line = version_anchor_line();
        for prompt in registered_prompts() {
            let item = format!("{} v{}", prompt.id, prompt.version);
            assert!(line.contains(&item), "锚点缺 {item}：{line}");
        }
        assert!(line.contains(&format!(
            "{} v{}",
            PROMPT_EQUIP_CATALOG.id, PROMPT_EQUIP_CATALOG.version
        )));
    }

    /// 话术三件套缺一件不算落地：登记在册的每个话术，台账的占位符表里都得有
    /// 「id | 版本」这一行。
    #[test]
    fn registry_matches_prompt_changelog() {
        let changelog = include_str!("../../resources/prompts/CHANGELOG.md");
        for prompt in registered_prompts() {
            let row = format!("| {} | {} |", prompt.id, prompt.version);
            assert!(
                changelog.contains(&row),
                "台账缺行或版本对不上：{row:?}（话术 {}）",
                prompt.id
            );
        }
    }
}
