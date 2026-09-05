//! Skill 导入命令（v0.9.0 需求20 第三轮）：创建对话框 Skill 工具类型
//! 支持导入既有 skill——①扫描各 agent 的 skill 根目录列表（只读）；
//! ②原生文件对话框选 SKILL.md（或含它的目录）读取解析。导入 = 回填表单
//! （副本语义，不直接落盘）；frontmatter 解析与 task_plan.rs 同形态。

use tauri_plugin_dialog::DialogExt;

#[derive(serde::Serialize)]
pub(crate) struct SkillSourceEntry {
    /// 来源 agent id（claude-code / jishu-self / opencode）。
    pub agent: String,
    /// skill 名（frontmatter name，缺省目录名）。
    pub name: String,
    /// frontmatter description（全量；前端列表自行截断展示）。
    pub description: String,
    /// SKILL.md 正文（选中即回填，免二次读取）。
    pub body: String,
    /// SKILL.md 绝对路径。
    pub path: String,
}

#[derive(serde::Serialize)]
pub(crate) struct SkillImportPayload {
    pub name: String,
    pub description: String,
    pub body: String,
}

/// 解析 SKILL.md：frontmatter（--- KV 块 ---）取 name/description，其余为
/// 正文（纯函数可单测；name 缺省 fallback_name）。
pub(crate) fn parse_skill_md(content: &str, fallback_name: &str) -> SkillImportPayload {
    let mut name = String::new();
    let mut description = String::new();
    let body;
    let trimmed = content.trim_start_matches('\u{feff}');
    if let Some(rest) = trimmed.strip_prefix("---") {
        // 找闭合 ---；未闭合则整段当正文（容错）。
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let v = v.trim().trim_matches('"').to_string();
                    match k.trim() {
                        "name" => name = v,
                        "description" => description = v,
                        _ => {}
                    }
                }
            }
            body = rest[end + 4..].trim_start_matches(['\r', '\n']).to_string();
        } else {
            body = trimmed.to_string();
        }
    } else {
        body = trimmed.to_string();
    }
    SkillImportPayload {
        name: if name.is_empty() {
            fallback_name.to_string()
        } else {
            name
        },
        description,
        body,
    }
}

/// skill 根目录扫描目标（表驱动；与 skill_deploy::skill_targets 同源思路，
/// 另加 opencode——其 skills 目录为生态通用形态）。
fn import_roots() -> Vec<(&'static str, std::path::PathBuf)> {
    let mut roots = Vec::new();
    let home = dirs::home_dir();
    if let Some(h) = &home {
        roots.push(("claude-code", h.join(".claude").join("skills")));
        roots.push(("opencode", h.join(".config").join("opencode").join("skills")));
    }
    if let Ok(agent_dir) = crate::agent::jishu_self::paths::agent_dir() {
        roots.push(("jishu-self", agent_dir.join("skills")));
    }
    roots
}

/// 扫描各 agent skill 根：每目录一个 skill（SKILL.md），只读不写。
#[tauri::command]
pub(crate) fn skill_import_sources() -> Vec<SkillSourceEntry> {
    let mut out = Vec::new();
    for (agent, root) in import_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let skill_md = entry.path().join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&skill_md) else {
                continue;
            };
            let dir_name = entry
                .file_name()
                .to_string_lossy()
                .to_string();
            let parsed = parse_skill_md(&content, &dir_name);
            out.push(SkillSourceEntry {
                agent: agent.to_string(),
                name: parsed.name,
                description: parsed.description,
                body: parsed.body,
                path: skill_md.to_string_lossy().to_string(),
            });
        }
    }
    out
}

/// 原生文件对话框选 SKILL.md（或含它的目录）→ 读取解析。取消返回
/// USER_CANCELLED（前端静默；与 export/import_config_dialog 同约定）。
#[tauri::command]
pub(crate) fn skill_import_file(app: tauri::AppHandle) -> Result<SkillImportPayload, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("SKILL.md", &["md"])
        .blocking_pick_file()
        .ok_or_else(|| "USER_CANCELLED".to_string())?;
    let path = picked
        .as_path()
        .ok_or_else(|| "Invalid file path".to_string())?
        .to_path_buf();
    // 选到目录（或 .md 命名不同）→ 尝试 <dir>/SKILL.md。
    let skill_md = if path.is_dir() {
        let inner = path.join("SKILL.md");
        if inner.is_file() {
            inner
        } else {
            return Err("所选目录中未找到 SKILL.md".to_string());
        }
    } else {
        path
    };
    let content = std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("读取失败：{e}"))?;
    let fallback = skill_md
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".to_string());
    Ok(parse_skill_md(&content, &fallback))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_skill_md_frontmatter_and_body() {
        let md = "---\nname: code-review\ndescription: 提交前自查清单\n---\n\n第一步：通读 diff。\n";
        let p = parse_skill_md(md, "fallback");
        assert_eq!(p.name, "code-review");
        assert_eq!(p.description, "提交前自查清单");
        assert!(p.body.starts_with("第一步：通读 diff。"));
    }

    #[test]
    fn parse_skill_md_defaults_and_tolerances() {
        // 无 frontmatter → 全正文 + fallback 名。
        let p = parse_skill_md("直接正文", "dir-name");
        assert_eq!(p.name, "dir-name");
        assert_eq!(p.description, "");
        assert_eq!(p.body, "直接正文");
        // frontmatter 无 name → fallback；带引号值剥引号。
        let p = parse_skill_md(
            "---\ndescription: \"quoted\"\n---\nbody",
            "dir-name",
        );
        assert_eq!(p.name, "dir-name");
        assert_eq!(p.description, "quoted");
        assert_eq!(p.body, "body");
        // 未闭合 frontmatter → 整段正文（容错）。
        let p = parse_skill_md("---\nname: x\nno closing", "d");
        assert_eq!(p.body, "---\nname: x\nno closing");
        // BOM 容错。
        let p = parse_skill_md("\u{feff}---\nname: bom\n---\nb", "d");
        assert_eq!(p.name, "bom");
    }
}
