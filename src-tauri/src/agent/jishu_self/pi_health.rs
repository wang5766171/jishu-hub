//! 公司「连接中断」修复 B（2026-11-27 用户裁决）：存量坏 pi 扩展的运行时治理。
//!
//! pi 对装载失败的扩展按上游设计 fail-loud（RPC 模式启动即退出；PI_CHANGE.MD
//! 已有裁决「拥抱 fail-loud，hub 负责用户永远停在健康态」）。需求15 方案 A 的
//! 探针只治理**新装**冲突；历史上装坏 / 与当前引擎版本不兼容的存量件会让引擎
//! 每次启动即退（用户公司机实测：所有会话「连接中断」，致命的
//! `Failed to load extension` 行又被 stderr 只留尾部的窗口切掉）。
//!
//! 这里补运行时面：握手期引擎退出且 stderr 带装载失败签名 → 解析坏件路径 →
//! 经 [`super::pi_registry`] 停用（登记簿 + 级联 + 移 pi 注册，幂等）→ 调用方
//! 把结果以中文告诉用户（重发即恢复）。只治理 pi settings `packages` 注册在案
//! 的 npm 件；hub 自部署（`agent/extensions/*.ts`）与未注册的池残留跳过（记录
//! 不动注册表）。

/// 运行时停用的台账原因串（兼作 `replaced_by`）。
/// 以 `runtime:` 开头——前端据此显示「装载失败自动停用」而非「被 X 替代」；
/// 没有任何卸载源会等于它，替代恢复钩子不会误触发。
pub(crate) const RUNTIME_DISABLE_REASON: &str = "runtime:extension-load-failure";

/// stderr 里是否带扩展装载失败签名（pi 诊断行前缀；廉价前置判断）。
pub(crate) fn has_extension_load_failure(stderr: &str) -> bool {
    stderr.contains("Failed to load extension")
}

/// stderr 里装载失败诊断行引用的扩展路径（`Failed to load extension "<path>"`），
/// 去重保序。Warning 行不含该前缀，不会误抓。
pub(crate) fn failed_extension_paths(stderr: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in stderr.lines() {
        // split_once 返回（前段, 后段）：取诊断前缀**之后**的部分，再按引号截出路径
        let Some((_, rest)) = line.split_once("Failed to load extension \"") else {
            continue;
        };
        let Some((path, _)) = rest.split_once('"') else {
            continue;
        };
        if !path.is_empty() && !out.iter().any(|p| p == path) {
            out.push(path.to_string());
        }
    }
    out
}

/// 从装载路径抽 npm 包目录（`…\npm\node_modules\@scope\pkg\…` → `@scope/pkg`；
/// 无 scope 取一段）。非 npm 池路径（hub 自部署的 `extensions/*.ts` 等）返回
/// None——那不是 packages 注册面能停用的东西。
fn npm_package_dir_of(path: &str) -> Option<String> {
    let norm = path.replace('\\', "/");
    const MARKER: &str = "/npm/node_modules/";
    let idx = norm.find(MARKER)?;
    let rest = &norm[idx + MARKER.len()..];
    let mut segs = rest.split('/');
    let first = segs.next()?.trim();
    if first.is_empty() || first.contains('.') {
        // 池根下的普通文件（package.json 等）不是包目录
        return None;
    }
    if let Some(scope) = first.strip_prefix('@') {
        if scope.is_empty() {
            return None;
        }
        let second = segs.next()?;
        if second.is_empty() {
            return None;
        }
        Some(format!("{first}/{second}"))
    } else {
        Some(first.to_string())
    }
}

/// 治理结果（调用方拼用户文案与日志用）。
#[derive(Debug, Default)]
pub(crate) struct HealOutcome {
    /// 已停用：(展示名, 注册串)。
    pub disabled: Vec<(String, String)>,
    /// 识别到但未治理的路径（不在注册表 / 非 npm 池 / 停用失败）。
    pub skipped: Vec<String>,
}

/// 按 stderr 治理装载失败的存量坏件。幂等（pi_registry::disable_extension
/// 自身幂等）；每处失败只记录不停流程。
pub(crate) fn heal_failed_extensions(stderr: &str) -> HealOutcome {
    let mut out = HealOutcome::default();
    for path in failed_extension_paths(stderr) {
        let Some(dir) = npm_package_dir_of(&path) else {
            log::warn!("[pi-health] 装载失败但非 npm 注册面，跳过停用：{path}");
            out.skipped.push(path);
            continue;
        };
        let Some(source) = super::pi_registry::registered_source_of(&dir) else {
            log::warn!("[pi-health] 装载失败但不在 pi 注册表（未注册的池残留），跳过停用：{path}");
            out.skipped.push(path);
            continue;
        };
        let display = super::pi_registry::builtin_pi_display_name(&dir).unwrap_or_else(|| dir.clone());
        match super::pi_registry::disable_extension(&source, &display, RUNTIME_DISABLE_REASON) {
            Ok(_) => out.disabled.push((display, source)),
            Err(e) => {
                log::warn!("[pi-health] 停用坏件失败（{source}）: {e}");
                out.skipped.push(path);
            }
        }
    }
    out
}

/// 用户文案（追加到会话错误消息后的中文句子；无停用成果时为空串）。
/// 口径同需求15-F1：只说功能状态与下一步，不带 stderr 原文/路径/术语。
pub(crate) fn heal_user_suffix(outcome: &HealOutcome) -> String {
    if outcome.disabled.is_empty() {
        return String::new();
    }
    let names: Vec<String> = outcome
        .disabled
        .iter()
        .map(|(display, _)| format!("「{display}」"))
        .collect();
    format!(
        "\n已自动停用无法装载的扩展：{}。请重发这条消息即可恢复。",
        names.join("、")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 诊断行的真实形状（公司日志 + 本机复现实测）。
    const STDERR_SHAPE: &str = "[pi-subagents] note\n\
Error: Failed to load extension \"C:\\Users\\dell\\.jishu-agent\\agent\\npm\\node_modules\\@juicesharp\\rpiv-todo\\index.ts\": Failed to load extension: boom\n\
Warning: Extension package \"C:\\Users\\dell\\.jishu-agent\\agent\\npm\\node_modules\\@juicesharp\\rpiv-ask-user-question\\package.json\": Host-provided extension packages must be declared in peerDependencies\n\
Warning: Extension package \"C:\\Users\\dell\\.jishu-agent\\agent\\npm\\node_modules\\@juicesharp\\rpiv-todo\\package.json\": Host-provided\n\
Hint: Start without extensions using \"jishu -ne\".";

    /// CH-U5：公司日志形状（Error 在前 Warning 在后）能抽出 npm 包目录；
    /// Warning 行不误抓；多条 Error 全抽出。
    #[test]
    fn parse_failed_extension_paths() {
        assert!(has_extension_load_failure(STDERR_SHAPE));
        assert!(!has_extension_load_failure("Warning: something else\nHint: x"));
        assert_eq!(
            failed_extension_paths(STDERR_SHAPE),
            vec!["C:\\Users\\dell\\.jishu-agent\\agent\\npm\\node_modules\\@juicesharp\\rpiv-todo\\index.ts".to_string()]
        );
        let two = format!("{STDERR_SHAPE}\nError: Failed to load extension \"C:\\x\\npm\\node_modules\\pi-web-access\\dist\\index.js\": bad");
        assert_eq!(
            failed_extension_paths(&two)
                .iter()
                .filter_map(|p| npm_package_dir_of(p))
                .collect::<Vec<_>>(),
            vec!["@juicesharp/rpiv-todo".to_string(), "pi-web-access".to_string()]
        );
        // 同一坏件报两遍只记一次
        let dup = format!("{STDERR_SHAPE}\n{}", STDERR_SHAPE.lines().nth(1).unwrap());
        assert_eq!(failed_extension_paths(&dup).len(), 1);
    }

    /// CH-U7 前半：非 npm 池路径（hub 自部署 extensions/*.ts）抽不出包目录。
    #[test]
    fn npm_dir_rejects_non_pool_paths() {
        assert_eq!(
            npm_package_dir_of("C:\\Users\\dell\\.jishu-agent\\agent\\extensions\\jishu-tool-approval.ts"),
            None
        );
        assert_eq!(npm_package_dir_of("C:\\proj\\local-ext\\index.ts"), None);
        // scoped 与无 scope 的正例
        assert_eq!(
            npm_package_dir_of("C:\\a\\npm\\node_modules\\@juicesharp\\rpiv-todo\\index.ts").as_deref(),
            Some("@juicesharp/rpiv-todo")
        );
        assert_eq!(
            npm_package_dir_of("/home/u/.jishu-agent/agent/npm/node_modules/pi-lens/x.ts").as_deref(),
            Some("pi-lens")
        );
    }

    /// CH-U6/U7：治理落库（隔离环境）——注册在案的坏件被停用（移注册 +
    /// 台账 disabled + replaced_by=runtime 签名）；不在注册表/非池路径跳过、
    /// 注册表原样。用户文案只提展示名。
    #[test]
    fn heal_disable_and_skip() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        std::env::set_var("JISHU_EXTENSIONS_DB", tmp.path().join("ext.db"));
        let pi_settings = tmp.path().join("pi-settings.json");
        std::fs::write(
            &pi_settings,
            r#"{"packages": ["npm:pi-lens@4.3.0", "npm:@juicesharp/rpiv-todo@2.11.0", "npm:pi-web-access@0.32.0"]}"#,
        )
        .unwrap();
        std::env::set_var("JISHU_PI_SETTINGS", &pi_settings);

        let stderr = format!(
            "{STDERR_SHAPE}\nError: Failed to load extension \"C:\\Users\\dell\\.jishu-agent\\agent\\extensions\\jishu-tool-approval.ts\": core broken"
        );
        let outcome = heal_failed_extensions(&stderr);
        assert_eq!(outcome.disabled.len(), 1, "只有注册在案的 rpiv-todo 被停用");
        assert_eq!(outcome.disabled[0].1, "npm:@juicesharp/rpiv-todo@2.11.0");
        assert!(outcome.skipped.iter().any(|p| p.contains("jishu-tool-approval")), "hub 自部署跳过: {:?}", outcome.skipped);

        let pkgs = super::super::pi_registry::registered_packages();
        assert!(!pkgs.iter().any(|p| p.contains("rpiv-todo")), "注册已移除: {pkgs:?}");
        assert!(pkgs.iter().any(|p| p.contains("pi-lens")), "其他注册不动");
        let overrides = super::super::pi_registry::load_overrides();
        assert_eq!(overrides.len(), 1);
        assert_eq!(overrides[0].replaced_by, RUNTIME_DISABLE_REASON);

        let suffix = heal_user_suffix(&outcome);
        assert!(suffix.contains("已自动停用无法装载的扩展"), "{suffix}");
        assert!(suffix.contains("「待办清单」"), "文案用展示名（builtin.json 有映射——rpiv-todo=待办清单）: {suffix}");
        assert!(suffix.contains("请重发这条消息"), "{suffix}");
        // 无停用成果 → 空串（错误消息保持原样）
        let none = HealOutcome::default();
        assert_eq!(heal_user_suffix(&none), "");

        std::env::remove_var("JISHU_HUB_HOME");
        std::env::remove_var("JISHU_PI_SETTINGS");
        std::env::remove_var("JISHU_EXTENSIONS_DB");
    }
}
