//! v0.9.4 需求12：开发日志中心强制开关（`~/.jishu-hub/settings.json`
//! 的 `devLogForced`，serde default 兼容历史）——设置页切换，开启后生产
//! 构建同样显示日志中心（安装包测试比 dev 稳定）。

#[tauri::command]
pub fn get_dev_log_forced() -> Result<bool, String> {
    Ok(crate::agent::jishu_self::jishu_settings::load()
        .map(|s| s.dev_log_forced)
        .unwrap_or(false))
}

#[tauri::command]
pub fn set_dev_log_forced(enabled: bool) -> Result<(), String> {
    let mut settings = crate::agent::jishu_self::jishu_settings::load()?;
    settings.dev_log_forced = enabled;
    crate::agent::jishu_self::jishu_settings::save(&settings)
}
