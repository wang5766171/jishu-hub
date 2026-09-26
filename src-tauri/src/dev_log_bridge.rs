//! v0.9.5 需求2 测试期（会话 01a0d868 复盘）：后端运行时关键事实 → 前端
//! 日志中心桥。
//!
//! 此前 Pi RPC 循环的状态迁移 / watchdog / 命令处置只落在 log::info!/
//! warn!（dev 终端 / release 日志文件），用户从日志中心粘贴的内容里完全
//! 没有后端视角——「prompt 到达时循环处于 Idle 还是 Prompting」「看门狗
//! 是否触发」等关键事实无法区分，定位只能靠代码推测。
//!
//! 桥为旁路通道：事件名 `hub-dev-log`，payload `{level, message, session,
//! data}`；前端 dev-log 侧以 [runtime] 类别写入环形缓冲（app.tsx 挂载时
//! attachRuntimeLogBridge 订阅），与既有前端日志同屏复制。
//!
//! 噪声预算：仅生命周期节点打点（每回合约 4-5 条），不逐事件。

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::Emitter;

/// (level, message, session, data) —— 前端 DevLogEntry 的子集投影。 */
pub type DevLogEmit = Arc<dyn Fn(&str, &str, &str, Value) + Send + Sync>;

/// GUI 会话用发射器（捕获 AppHandle，emit `hub-dev-log` 事件）。 */
pub fn dev_log_emitter(app: &tauri::AppHandle) -> DevLogEmit {
    let app = app.clone();
    Arc::new(move |level: &str, message: &str, session: &str, data: Value| {
        let _ = app.emit(
            "hub-dev-log",
            json!({
                "level": level,
                "message": message,
                "session": session,
                "data": data,
            }),
        );
    })
}

/// 编排器会话（无 AppHandle）的空实现——非 GUI 会话不进日志中心。 */
pub fn noop_dev_log_emitter() -> DevLogEmit {
    Arc::new(|_level: &str, _message: &str, _session: &str, _data: Value| {})
}
