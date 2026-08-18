//! jishu agent 目录路径的单一来源（v0.7.4 审查 A8 收敛，v0.7.5 实施）。
//!
//! Pi fork 经 `PI_CODING_AGENT_DIR=~/.jishu-agent` 隔离自有 runtime 数据
//!（DEVELOP_READ §7.1）。两层结构：
//! - 根目录 `~/.jishu-agent`：环境变量指向值（agent 本体/npm 装载）；
//! - agent 目录 `~/.jishu-agent/agent`：Pi 原生 `getAgentDir()`，
//!   settings.json / models.json / sessions / extensions / backups 所在。
//!
//! 此前 6+ 文件各自 `home.join(".jishu-agent")` 拼接（34 处），无单点来源；
//! 新代码禁止再手拼这两个目录，一律从本模块取。`*_for_home` 参数化版本
//! 供测试注入虚拟 home。

use std::path::{Path, PathBuf};

/// Pi agent 根目录（`~/.jishu-agent`；= PI_CODING_AGENT_DIR 的值）。
pub(crate) fn agent_root_for_home(home: &Path) -> PathBuf {
    home.join(".jishu-agent")
}

/// Pi 原生 getAgentDir()：`<root>/agent`。
pub(crate) fn agent_dir_for_home(home: &Path) -> PathBuf {
    agent_root_for_home(home).join("agent")
}

fn home() -> Result<PathBuf, Box<dyn std::error::Error>> {
    dirs::home_dir().ok_or("Cannot find home directory".into())
}

pub(crate) fn agent_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(agent_root_for_home(&home()?))
}

pub(crate) fn agent_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(agent_dir_for_home(&home()?))
}

/// 全局 settings.json（Pi Settings schema，行为页/配置页读写）。
pub(crate) fn settings_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(agent_dir()?.join("settings.json"))
}

/// models.json（Pi 启动时读取的渠道/模型库）。
pub(crate) fn models_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(agent_dir()?.join("models.json"))
}

/// mcp.json（pi-mcp-adapter 读取的 MCP 服务器定义，与 settings.json 同步）。
pub(crate) fn mcp_json_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(agent_dir()?.join("mcp.json"))
}

/// 会话根目录（项目路径编码为子目录）。
pub(crate) fn sessions_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(agent_dir()?.join("sessions"))
}

/// settings.json/models.json 自动备份目录。
pub(crate) fn backups_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(agent_dir()?.join("backups"))
}
