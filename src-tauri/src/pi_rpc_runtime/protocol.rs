//! pi_rpc_runtime 子模块（v0.9.5 三轮评审 C13 拆分：零逻辑变更纯移动，
//! 来源与拆分说明见主文件头 §12 处置说明）。

use super::*;

// ---------------------------------------------------------------------------
// Event emission helpers
// ---------------------------------------------------------------------------

/// Convert a Pi `extension_ui_request` event to a `NormalizedEvent::InteractionRequest`.
///
/// Pi's extension_ui protocol emits requests for select/input/confirm. Only
/// `select` and `input` are converted (they require a user response). Fire-and-
/// forget methods (notify, setStatus, etc.) are ignored.
/// v0.8.0 需求1 P-2：审批型 extension_ui 的待回写登记（Delegate 路径）。
/// 「该 request_id 已登记审批」标记（字段无读取面——ResolvePermission 按 id 回写）。
pub(crate) struct PiToolApproval;

/// v0.9.5 需求5 测试期 T1：rpiv-ask 哨兵行适配。包的 RPC 问答器给每道
/// 单选题自动追加 "N. Type something." 自定义输入行（i18n 未装时英文
/// 兜底，包固有设计不可配置）；hub 卡片另有自带「其他」输入——双入口
/// 重复且语义错位（哨兵行需二次输入、纯文本回传会被扩展按取消处理）。
/// 适配三步（02 测试期 T1 定案）：① select 末项命中哨兵 → 从卡面剥离
/// （登记 request_id→哨兵原文）；② 「其他」纯文本应答 → 回传改写为哨兵
/// 原文（扩展协议要求选项原文），原文暂存；③ 哨兵触发的 input 追问到达
/// → 用暂存文本幕后自动应答（不转发前端）。检测失败优雅降级走旧路径。
pub(crate) fn is_sentinel_option(option: &str) -> bool {
    let Some(rest) = option.strip_suffix("Type something.") else {
        return false;
    };
    let Some(num) = rest.strip_suffix(". ") else {
        return false;
    };
    !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit())
}

/// T1：request_id → 哨兵选项原文（应答改写取用即消费）。
/// 三轮评审 B2：有界守护——未应答交互的条目无自然满理时机（用户关卡/
/// 会话终止），尺寸超限时整体清空（登记丢失仅降级为「不剥哨兵行/不翻译」，
/// 优雅降级路径在，语义无损）。
pub(crate) static INTERACTION_SENTINELS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, String>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// 协议表尺寸上限（到达即清空——每条登记仅几十字节，256 条对应极端的
/// 未应答交互堆积，远超任何正常会话负载）。
pub(crate) const PROTOCOL_TABLE_LIMIT: usize = 256;

/// B2：登记前守护（超限清空）。
fn bounded_insert_sentinel(id: String, sentinel: String) {
    let mut reg = INTERACTION_SENTINELS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if reg.len() >= PROTOCOL_TABLE_LIMIT {
        reg.clear();
        log::warn!("[pi-ext] INTERACTION_SENTINELS 达上限 {PROTOCOL_TABLE_LIMIT}，整体清空（未应答交互堆积——仅降级不影响正确性）");
    }
    reg.insert(id, sentinel);
}

/// T1：session_id → 用户自定义文本（哨兵追问 input 到达时自动应答）。
pub(crate) static INTERACTION_AUTO_ANSWER: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, String>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// T1 ①：select 请求剥离末尾哨兵行（非 select / 无哨兵原样返回）。
pub(crate) fn strip_sentinel_option(mut msg: serde_json::Value) -> serde_json::Value {
    if msg.get("method").and_then(|v| v.as_str()) != Some("select") {
        return msg;
    }
    let Some(options) = msg.get_mut("options").and_then(|v| v.as_array_mut()) else {
        return msg;
    };
    let sentinel = match options.last().and_then(|v| v.as_str()) {
        Some(last) if is_sentinel_option(last) => last.to_string(),
        _ => return msg,
    };
    options.pop();
    if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
        bounded_insert_sentinel(id.to_string(), sentinel);
    }
    msg
}

/// T1 ③：取走（消费）本会话挂起的哨兵自动应答文本。
pub(crate) fn take_interaction_auto_answer(session_id: &str) -> Option<String> {
    INTERACTION_AUTO_ANSWER
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(session_id)
}

/// v0.9.5 四轮评审 P2-1：会话 resolve（pending 幂等 id → pi 真实 id）时把
/// 挂起的哨兵自动应答键随迁——登记与消费键均为真实 id，不迁移则键位不同
/// 源（新会话场景清扫 miss）。真实键已有值时保守不覆盖。
pub(crate) fn migrate_auto_answer_key(from: &str, to: &str) {
    if from == to {
        return;
    }
    let mut reg = INTERACTION_AUTO_ANSWER
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(v) = reg.remove(from) {
        log::info!("[pi-ext] interaction auto-answer key migrated: {from} -> {to}");
        reg.entry(to.to_string()).or_insert(v);
    }
}

/// v0.9.5 需求5 测试期 T5：rpiv-ask 多选题 RPC 降级还原。包在 RPC 宿主把
/// 多选题降级为 `ui.input`——题干塞选项列表 + 英文序号说明（包固有权衡，
/// rpc-fallback.ts MULTI_SELECT_INSTRUCTIONS 常量）。hub 转换层还原成真
/// 多选卡：检测该固定格式 → 改写为 multiSelect 交互请求（可点选）；
/// 作答时把选择翻译回扩展期待的「1,3」序号串（rewrite_multiselect_
/// response）。检测失败（如装了 rpiv-i18n 后文案本地化）优雅降级为
/// 原输入框形态。
/// ⚠ 三轮评审 B4（vendor 协议耦合）：本常量与哨兵行匹配（is_sentinel_
/// option 的 "N. Type something."）均精确耦合 @juicesharp/rpiv-ask-user-
/// question 包的英文常量——升级该包或装 rpiv-i18n 本地化时会**静默**降级
/// （不报错但无人知晓）。升级包时必回归 sentinel_option_detection 与
/// multiselect 相关测试；建议治理该包的 plugin.toml 钉定版本。
const MULTI_SELECT_INSTRUCTIONS: &str = "Enter the numbers of all that apply, comma-separated (e.g. \"1,3\"), or type a custom answer as plain text.";

/// T5：request_id 登记集（该 input 已被还原为多选卡，应答需序号翻译）。
pub(crate) static MULTI_SELECT_REQUESTS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashSet<String>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

/// 选项行带 "N. " 序号前缀（rpiv formatOptionLine 形态）。
fn numbered_option_line(line: &str) -> bool {
    let Some((num, rest)) = line.split_once(". ") else {
        return false;
    };
    !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit()) && !rest.is_empty()
}

/// T5 ①：input → multiSelect 还原（非多选形态原样返回）。题干结构 =
/// "{header}{question}\n\n{序号选项行…}\n\n{英文序号说明}"（包侧拼接顺序）。
pub(crate) fn rewrite_multiselect_input(mut msg: serde_json::Value) -> serde_json::Value {
    if msg.get("method").and_then(|v| v.as_str()) != Some("input") {
        return msg;
    }
    let Some(title) = msg
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        return msg;
    };
    let Some(stripped) = title
        .strip_suffix(MULTI_SELECT_INSTRUCTIONS)
        .and_then(|t| t.strip_suffix("\n\n"))
    else {
        return msg;
    };
    let Some((question, list)) = stripped.split_once("\n\n") else {
        return msg;
    };
    let lines: Vec<String> = list.split('\n').map(str::to_string).collect();
    if lines.is_empty() || !lines.iter().all(|l| numbered_option_line(l)) {
        return msg;
    }
    let id = msg
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return msg;
    }
    let mut reg = MULTI_SELECT_REQUESTS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if reg.len() >= PROTOCOL_TABLE_LIMIT {
        reg.clear();
        log::warn!("[pi-ext] MULTI_SELECT_REQUESTS 达上限 {PROTOCOL_TABLE_LIMIT}，整体清空（未应答交互堆积）");
    }
    reg.insert(id.clone());
    msg["method"] = serde_json::Value::String("multiSelect".to_string());
    msg["title"] = serde_json::Value::String(question.to_string());
    msg["options"] =
        serde_json::Value::Array(lines.into_iter().map(serde_json::Value::String).collect());
    log::info!("[pi-ext] multi-select input restored to selectable card (id {id})");
    msg
}

/// T5 ②：多选卡应答翻译——选中项（"N. xxx" 原文）→ "1,3" 序号串（扩展
/// grammar：全数字 token 才算选择，否则整串按自定义答案）。纯自定义文本
/// 原样透传；任一选中项解析不出序号则原样返回（安全降级）。
pub(crate) fn rewrite_multiselect_response(
    request_id: &str,
    value: &str,
    interaction: Option<&serde_json::Value>,
) -> String {
    let known = MULTI_SELECT_REQUESTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(request_id);
    if !known {
        return value.to_string();
    }
    let selected: Vec<String> = interaction
        .and_then(|v| v.get("selected_options"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if selected.is_empty() {
        return value.to_string();
    }
    let mut numbers: Vec<String> = Vec::with_capacity(selected.len());
    for option in &selected {
        let Some((num, _)) = option.split_once(". ") else {
            return value.to_string();
        };
        if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
            return value.to_string();
        }
        numbers.push(num.to_string());
    }
    numbers.join(",")
}

/// T1 ②：应答改写——PiRpc select 的「其他」纯文本应答（无选中项）且该
/// 请求挂有哨兵时，回传哨兵原文、暂存用户文本（chat.rs respond 路径调用；
/// 其余情形原样返回 value）。
pub(crate) fn rewrite_sentinel_response(
    request_id: &str,
    session_id: &str,
    value: &str,
    interaction: Option<&serde_json::Value>,
) -> String {
    if value.is_empty() {
        return value.to_string();
    }
    let selected_empty = interaction
        .and_then(|v| v.get("selected_options"))
        .and_then(|v| v.as_array())
        .map_or(true, |arr| arr.is_empty());
    if !selected_empty {
        return value.to_string();
    }
    let sentinel = INTERACTION_SENTINELS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(request_id);
    match sentinel {
        Some(s) => {
            let mut reg = INTERACTION_AUTO_ANSWER
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if reg.len() >= PROTOCOL_TABLE_LIMIT {
                reg.clear();
                log::warn!("[pi-ext] INTERACTION_AUTO_ANSWER 达上限 {PROTOCOL_TABLE_LIMIT}，整体清空（未送达的追问堆积）");
            }
            reg.insert(session_id.to_string(), value.to_string());
            log::info!("[pi-ext] sentinel rewrite for request {request_id} (session {session_id})");
            s
        }
        None => value.to_string(),
    }
}

pub(crate) fn convert_extension_ui_request(msg: &serde_json::Value) -> Option<NormalizedEvent> {
    let method = msg.get("method").and_then(|v| v.as_str())?;
    let id = msg.get("id").and_then(|v| v.as_str())?.to_string();
    match method {
        "select" | "multiSelect" => {
            let allow_multiple = method == "multiSelect";
            let title = msg
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("请选择")
                .to_string();
            let options = msg
                .get("options")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| {
                            v.as_str().map(|s| InteractionOption {
                                option_id: s.to_string(),
                                label: s.to_string(),
                                description: None,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(NormalizedEvent::InteractionRequest {
                request_id: id,
                prompt: title,
                options,
                allow_multiple,
                allow_custom_text: true,
                required: true,
                // Pi `extension_ui` is the production mid-turn baseline.
                transport: InteractionTransport::PiRpc,
                origin: InteractionOrigin::ExtensionUi,
                delivery_hint: InteractionDeliveryHint::MidTurn,
                correlation: None,
            })
        }
        "input" => {
            let title = msg
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("请输入")
                .to_string();
            Some(NormalizedEvent::InteractionRequest {
                request_id: id,
                prompt: title,
                options: vec![],
                allow_multiple: false,
                allow_custom_text: true,
                required: true,
                transport: InteractionTransport::PiRpc,
                origin: InteractionOrigin::ExtensionUi,
                delivery_hint: InteractionDeliveryHint::MidTurn,
                correlation: None,
            })
        }
        // setStatus with key "jishu-conductor-phase" → PhaseDivider event
        "setStatus" => {
            let status_key = msg.get("statusKey").and_then(|v| v.as_str()).unwrap_or("");
            let status_text = msg.get("statusText").and_then(|v| v.as_str()).unwrap_or("");
            if status_key == "jishu-conductor-phase" && !status_text.is_empty() {
                let title = match status_text {
                    "discuss" => "需求讨论",
                    "plan" => "流程规划",
                    "execute" => "流程执行",
                    "done" => "已完成",
                    other => other,
                };
                Some(NormalizedEvent::PhaseDivider {
                    phase: status_text.to_string(),
                    title: title.to_string(),
                })
            } else {
                None
            }
        }
        // confirm, notify, setWidget, setTitle, set_editor_text:
        // fire-and-forget or not mapped to InteractionRequest.
        _ => None,
    }
}
