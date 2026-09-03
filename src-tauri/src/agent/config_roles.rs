//! ConfigAdapter 角色拆分（v0.8.1 需求1 M1）：能力即接口 + 可选向下转型。
//!
//! v0.8.0 的 ConfigAdapter 是胖接口——20 个「Not supported」默认方法 +
//! `supports_mcp` / `supports_transport_bridge` 布尔双轨。调用方只能
//! 「调用后 catch Err」或查布尔再调，能力声明与能力实现分裂。
//!
//! 拆分后每个可选能力是一个独立角色 trait，ConfigAdapter 持 6 个
//! `as_xxx()` 访问器（默认 None）；实现方按能力声明 `Some(self)`，
//! 调用方先判 None 再走角色方法——不支持是结构化的，不再是运行时 Err。

use serde_json::Value;
use std::future::Future;
use std::pin::Pin;

/// 原始配置读写（raw 编辑器面板）：直接操作 agent 的配置文件文本。
pub trait RawConfigStore: Send + Sync {
    fn load_raw_config(&self) -> Result<String, String>;
    fn save_raw_config(&self, content: &str) -> Result<(), String>;
    /// raw 编辑器高亮格式（"json" / "toml"），仅 raw 面有意义。
    fn config_format(&self) -> Option<String> {
        None
    }
}

/// 配置备份：列表 / 恢复 / 导出 / 导入。
pub trait ConfigBackupStore: Send + Sync {
    fn list_backups(&self) -> Result<Vec<crate::config::BackupEntry>, String>;
    fn restore_backup(&self, path: &str) -> Result<(), String>;
    fn export_config(&self, path: &str) -> Result<(), String>;
    fn import_config(&self, path: &str) -> Result<Value, String>;
}

/// 模型仓库（model store 配置面）：模型列表与激活模型的读写。
pub trait ModelStore: Send + Sync {
    fn load_model_store(&self) -> Result<Value, String>;
    fn save_model_store(&self, config: &Value) -> Result<(), String>;
    fn get_active_model(&self) -> Result<Option<Value>, String>;
    fn set_active_model(&self, active: Option<&Value>) -> Result<(), String>;
}

/// MCP 适配器集成（如 jishu-self 的 mcp 转发桥）。
pub trait McpIntegration: Send + Sync {
    fn check_mcp(&self) -> Result<Value, String>;
    fn install_mcp(&self) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + '_>>;
    fn update_mcp(&self) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + '_>>;
    /// 状态检查前的自动迁移钩子（老配置格式 → 新格式），默认无操作。
    fn migrate_mcp_if_needed(&self) {}
}

/// 传输桥依赖（如 claude_code 的 claude-agent-acp）。
pub trait TransportBridgeDependency: Send + Sync {
    fn check_transport_bridge(&self) -> Result<Value, String>;
    fn install_transport_bridge(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + '_>>;
}

/// 权限模式读写（AgentConfig 提供方：agent 自己的配置文件）。
pub trait PermissionModeConfig: Send + Sync {
    fn get_permission_mode(&self) -> Result<Option<String>, String>;
    fn set_permission_mode(&self, mode: &str) -> Result<(), String>;
}
