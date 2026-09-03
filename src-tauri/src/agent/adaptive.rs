//! 自适应插件适配引擎（v0.8.1 需求10）。
//!
//! ⚠️ M6 现状标注：本模块的 resolve_form/needs_pi_deploy/participates_in_injection
//! 目前**零生产调用**（v1 实际适配由 load_manifests 的 kind 分流隐式完成；
//! [pi_extension].entry 与 conductor 部署管线也未接线）。保留为需求10
//! （pi 扩展 × hub 插件统一管理）的骨架，接线点见《插件系统改造实施计划》
//! §七——排期前保持显式标注的死链状态而非删除。
//!
//! 一个插件实体在不同智能体上自动适配不同执行形态——管理面统一为一个
//! 插件（一个条目/一个开关），形态是内部实现细节：
//!
//! - jishu-self（pi 进程）→ pi ExtensionAPI 代码（深度形态：状态机/确认卡）
//! - 其他 agent（claude-code/codex/opencode）→ [tool] 段 prompt 注入 CLI 命令
//!
//! 适配依据是插件声明（plugin.toml）的 `[pi_extension]` 与 `[tool]` 段：
//! 有哪个段就有哪条通道；两段并存 = 自适应插件。不存在"创建两个插件"——
//! 声明与执行分离，hub 适配层决定怎么做到。
#![allow(dead_code)]

use std::path::PathBuf;

use super::manifest::schema::{AgentManifestFile, ToolSection};

/// 插件在某个目标 agent 上的可用形态。
#[derive(Debug, Clone)]
pub enum AdaptiveForm {
    /// 仅 CLI 工具（prompt 注入 [tool] 段的 usage）。
    CliOnly { tool: ToolSection },
    /// 仅 pi 扩展（jishu-self 专属，[pi_extension] 段）。
    PiOnly { entry: PathBuf },
    /// 两者并存（jishu-self 上 agent 自选深度或通用）。
    Both { entry: PathBuf, tool: ToolSection },
    /// 该 agent 上不可用（无匹配形态）。
    None,
}

/// 按插件声明 + 目标 agent 判定可用形态。
///
/// 这是适配层的唯一入口——上层（插件页/注入管线/pi 部署管线）经此获取
/// "这个插件在当前 agent 上走哪条通道"，不需要了解段的并存细节。
pub fn resolve_form(
    manifest: &AgentManifestFile,
    plugin_dir: &PathBuf,
    target_agent: &str,
) -> AdaptiveForm {
    let pi_entry = manifest.pi_extension.as_ref().and_then(|section| {
        if section.target_agent == target_agent {
            Some(plugin_dir.join(&section.entry))
        } else {
            None
        }
    });
    let tool = manifest.tool.clone();

    match (pi_entry, tool) {
        (Some(entry), Some(tool)) => AdaptiveForm::Both { entry, tool },
        (Some(entry), None) => AdaptiveForm::PiOnly { entry },
        (None, Some(tool)) => AdaptiveForm::CliOnly { tool },
        (None, None) => AdaptiveForm::None,
    }
}

/// 该插件是否需要部署 pi 扩展（管理面/部署管线用）。
pub fn needs_pi_deploy(manifest: &AgentManifestFile) -> bool {
    manifest.pi_extension.is_some()
}

/// 该插件是否参与 prompt 注入（tool_plugin 管线用）。
pub fn participates_in_injection(manifest: &AgentManifestFile) -> bool {
    manifest.tool.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::manifest::schema::{
        InfoSection, ManifestKind, PiExtensionSection, ToolSection,
    };

    fn manifest(tool: Option<ToolSection>, pi: Option<PiExtensionSection>) -> AgentManifestFile {
        AgentManifestFile {
            schema: 1,
            kind: ManifestKind::Tool,
            info: InfoSection {
                id: "adaptive-demo".to_string(),
                display_name: "Demo".to_string(),
                icon: String::new(),
                install_hint: None,
            },
            probe: None,
            transport: None,
            config: None,
            session: None,
            capabilities: None,
            tool,
            pi_extension: pi,
        }
    }

    fn tool_section() -> ToolSection {
        ToolSection {
            description: "demo".to_string(),
            usage: "demo-cmd".to_string(),
            example: None,
            notes: None,
        }
    }

    fn pi_section(target: &str) -> PiExtensionSection {
        PiExtensionSection {
            entry: "index.ts".to_string(),
            target_agent: target.to_string(),
        }
    }

    #[test]
    fn adaptive_resolves_both_for_target_agent() {
        let m = manifest(Some(tool_section()), Some(pi_section("jishu-self")));
        let dir = PathBuf::from("/plugins/adaptive-demo");
        match resolve_form(&m, &dir, "jishu-self") {
            AdaptiveForm::Both { entry, .. } => {
                assert!(entry.ends_with("index.ts"));
            }
            other => panic!("expected Both, got {other:?}"),
        }
    }

    #[test]
    fn adaptive_resolves_cli_only_for_other_agent() {
        let m = manifest(Some(tool_section()), Some(pi_section("jishu-self")));
        let dir = PathBuf::from("/plugins/adaptive-demo");
        match resolve_form(&m, &dir, "claude-code") {
            AdaptiveForm::CliOnly { .. } => {}
            other => panic!("expected CliOnly, got {other:?}"),
        }
    }

    #[test]
    fn adaptive_resolves_none_when_no_matching_form() {
        // 无 tool 无 pi → 不可用
        let m = manifest(None, None);
        let dir = PathBuf::from("/plugins/x");
        assert!(matches!(
            resolve_form(&m, &dir, "jishu-self"),
            AdaptiveForm::None
        ));

        // pi 扩展 target 不匹配且无 tool → 不可用
        let m = manifest(None, Some(pi_section("jishu-self")));
        assert!(matches!(
            resolve_form(&m, &dir, "codex"),
            AdaptiveForm::None
        ));
    }

    #[test]
    fn pi_only_when_no_tool_section() {
        let m = manifest(None, Some(pi_section("jishu-self")));
        let dir = PathBuf::from("/plugins/x");
        match resolve_form(&m, &dir, "jishu-self") {
            AdaptiveForm::PiOnly { .. } => {}
            other => panic!("expected PiOnly, got {other:?}"),
        }
    }
}
