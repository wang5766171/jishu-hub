const fs = require("fs");
const p = "src-tauri/src/pi_rpc_runtime.rs";
let s = fs.readFileSync(p, "utf8");
const CRLF = s.includes("\r\n");
const j = (t) => t.replace(/\n/g, CRLF ? "\r\n" : "\n");

// ── 3. helper 函数（LoopState 定义后插）──
const o3 = j("const IDLE_TIMEOUT: Duration = Duration::from_secs(600);");
const n3 = j(`const IDLE_TIMEOUT: Duration = Duration::from_secs(600);

/// v0.9.5 需求2 测试期：Prompting 状态的回合启动 watchdog——prompt 发出后
/// 该时限内无任何 pi 事件（连 message_start 都没有）视为回合未启动。
const PROMPT_ACK_TIMEOUT: Duration = Duration::from_secs(20);
/// CancelPending（abort 后）收尾 watchdog 超时——超时杀进程终结流。
const CANCEL_SETTLE_TIMEOUT: Duration = Duration::from_secs(15);

/// Prompting 且 prompt 后未收到任何事件 → watchdog deadline；事件到达时
/// state 由 prompt_ack 清零（见事件分支头部）。deadline 计算基于
/// `prompt_ack_deadline_at`（Some=等待中）。
fn prompt_watchdog_deadline(state: &LoopState) -> Option<tokio::time::Instant> {
    if matches!(state, LoopState::Prompting) {
        Some(tokio::time::Instant::now() + PROMPT_ACK_TIMEOUT)
    } else {
        None
    }
}

fn cancel_watchdog_deadline(state: &LoopState) -> Option<tokio::time::Instant> {
    if matches!(state, LoopState::CancelPending { .. }) {
        Some(tokio::time::Instant::now() + CANCEL_SETTLE_TIMEOUT)
    } else {
        None
    }
}

const IDLE_TIMEOUT: Duration = Duration::from_secs(600);`);
if (!s.includes(o3)) { console.error("o3 miss"); process.exit(1); }
s = s.replace(o3, n3);
fs.writeFileSync(p, s);
console.log("helpers ok");
