use serde::Serialize;
use std::path::{Path, PathBuf};

fn serialize_pathbuf<S: serde::Serializer>(path: &PathBuf, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&path.to_string_lossy())
}

#[derive(Debug, Clone, Serialize)]
pub struct Project {
    pub name: String,
    #[serde(serialize_with = "serialize_pathbuf")]
    pub path: PathBuf,
    pub encoded_name: String,
    pub session_count: usize,
    pub last_active: Option<String>,
    pub has_claude_md: bool,
    #[serde(default)]
    pub agent_ids: Vec<String>,
    #[serde(default)]
    pub initialized: bool,
}

pub fn scan_projects() -> Vec<Project> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let projects_dir = home.join(".claude").join("projects");

    // v0.7.2 需求 1 / M4.1：一次性加载隐藏集合，避免每个项目重读 hidden_projects.json
    let hidden = crate::hub::load_hidden_set();

    let mut projects = Vec::new();
    let mut seen_encoded = std::collections::HashSet::new();

    // Scan Claude Code projects
    if projects_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                let encoded_name = entry.file_name().to_string_lossy().to_string();
                if hidden.contains(&encoded_name) {
                    continue;
                }
                if let Some(project) = parse_project(&projects_dir, &encoded_name) {
                    seen_encoded.insert(project.encoded_name.clone());
                    projects.push(project);
                }
            }
        }
    }

    // Add manual projects
    if let Ok(manual_paths) = crate::hub::load_manual_projects() {
        for path in &manual_paths {
            let encoded = encode_project_path(path);
            if seen_encoded.contains(&encoded) {
                continue;
            }
            if hidden.contains(&encoded) {
                continue;
            }
            if let Some(project) = build_project_from_path(path) {
                seen_encoded.insert(project.encoded_name.clone());
                projects.push(project);
            }
        }
    }

    // Filter out merged secondaries
    let secondaries = crate::hub::get_all_secondaries().unwrap_or_default();
    projects.retain(|p| !secondaries.contains(&p.encoded_name));

    // Aggregate session counts from merged secondaries into primaries
    if let Ok(merges) = crate::hub::load_project_merges() {
        for (primary, secs) in &merges.merges {
            if let Some(primary_project) = projects.iter_mut().find(|p| p.encoded_name == *primary)
            {
                for sec in secs {
                    let sec_dir = projects_dir.join(sec);
                    if sec_dir.exists() {
                        primary_project.session_count += count_sessions(&sec_dir);
                    }
                }
            }
        }
    }

    projects.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    projects
}

pub fn merge_projects(projects: Vec<Project>) -> Vec<Project> {
    let secondaries = crate::hub::get_all_secondaries().unwrap_or_default();
    let mut merged: Vec<Project> = Vec::new();

    for project in projects {
        if crate::hub::is_project_hidden(&project.encoded_name).unwrap_or(false)
            || secondaries.contains(&project.encoded_name)
        {
            continue;
        }

        if let Some(existing) = merged
            .iter_mut()
            .find(|item| item.encoded_name == project.encoded_name)
        {
            existing.session_count = existing.session_count.max(project.session_count);
            existing.initialized = existing.initialized || project.initialized;
            existing.has_claude_md = existing.has_claude_md || project.has_claude_md;
            if project.last_active > existing.last_active {
                existing.last_active = project.last_active.clone();
            }
            for agent_id in project.agent_ids {
                if !existing.agent_ids.contains(&agent_id) {
                    existing.agent_ids.push(agent_id);
                }
            }
        } else {
            merged.push(project);
        }
    }

    merged.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    merged
}

pub fn project_from_agent_path(
    path: &str,
    agent_id: &str,
    session_count: usize,
    last_active: Option<String>,
) -> Option<Project> {
    let project_path = Path::new(path);
    if !project_path.is_dir() {
        return None;
    }

    let name = project_path.file_name()?.to_string_lossy().to_string();
    let encoded = encode_project_path(path);

    Some(Project {
        name,
        path: project_path.to_path_buf(),
        encoded_name: encoded,
        session_count,
        last_active,
        has_claude_md: project_path.join(".claude").join("CLAUDE.md").exists(),
        agent_ids: vec![agent_id.to_string()],
        initialized: true,
    })
}

/// Build a Project from a filesystem path (for manually added projects)
fn build_project_from_path(path: &str) -> Option<Project> {
    let project_path = std::path::Path::new(path);
    if !project_path.is_dir() {
        return None;
    }

    let name = project_path.file_name()?.to_string_lossy().to_string();
    let encoded = encode_project_path(path);

    let home = dirs::home_dir()?;
    let claude_project_dir = home.join(".claude").join("projects").join(&encoded);
    let initialized = claude_project_dir.is_dir();

    let session_count = if initialized {
        count_sessions(&claude_project_dir)
    } else {
        0
    };

    let last_active = if initialized {
        get_last_active(&claude_project_dir)
    } else {
        None
    };

    Some(Project {
        name,
        path: project_path.to_path_buf(),
        encoded_name: encoded,
        session_count,
        last_active,
        has_claude_md: project_path.join(".claude").join("CLAUDE.md").exists(),
        agent_ids: detect_project_agents(project_path, &claude_project_dir),
        initialized,
    })
}

fn parse_project(projects_dir: &Path, encoded_name: &str) -> Option<Project> {
    let project_dir = projects_dir.join(encoded_name);
    if !project_dir.is_dir() {
        return None;
    }

    let decoded_path = decode_project_path(encoded_name);
    let name = Path::new(&decoded_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let session_count = count_sessions(&project_dir);
    let last_active = get_last_active(&project_dir);
    let has_claude_md = Path::new(&decoded_path)
        .join(".claude")
        .join("CLAUDE.md")
        .exists();
    let agent_ids = detect_project_agents(Path::new(&decoded_path), &project_dir);
    // A project is "initialized" if it has a record in ~/.claude/projects/
    let initialized = project_dir.is_dir();

    Some(Project {
        name,
        path: PathBuf::from(&decoded_path),
        encoded_name: encoded_name.to_string(),
        session_count,
        last_active,
        has_claude_md,
        agent_ids,
        initialized,
    })
}

fn detect_project_agents(project_path: &Path, claude_project_dir: &Path) -> Vec<String> {
    let mut agents = Vec::new();
    if claude_project_dir.is_dir() || project_path.join(".claude").join("CLAUDE.md").exists() {
        agents.push("claude-code".to_string());
    }
    if project_path.join("opencode.json").exists()
        || project_path.join("opencode.jsonc").exists()
        || project_path.join("opencode.toml").exists()
        || project_path.join(".opencode").is_dir()
    {
        agents.push("opencode".to_string());
    }
    agents
}

pub fn decode_project_path(encoded: &str) -> String {
    // Claude Code encodes paths: ':\' → '--', then '\'/' → '-', and spaces → '-'.
    // This makes decoding ambiguous (e.g., "TestProject---2" could be "TestProject - 2",
    // "TestProject-- 2", etc.). We resolve by matching against actual filesystem entries.
    if let Some(result) = decode_from_known_prefix(encoded) {
        return result.to_string_lossy().to_string();
    }

    if let Some(pos) = encoded.find("--") {
        let drive = &encoded[..pos];
        let rest = &encoded[pos + 2..];
        let base = PathBuf::from(format!("{}:\\", drive));

        if let Some(result) = decode_by_fs_matching(&base, rest) {
            return result.to_string_lossy().to_string();
        }

        // Fallback for deleted/missing directories
        format!("{}:\\{}", drive, rest.replace('-', "\\"))
    } else {
        encoded.replace('-', "\\")
    }
}

fn decode_from_known_prefix(encoded: &str) -> Option<PathBuf> {
    let mut prefixes = Vec::new();
    if let Some(home) = dirs::home_dir() {
        prefixes.push(home);
    }
    prefixes.push(std::env::temp_dir());
    if let Ok(cwd) = std::env::current_dir() {
        prefixes.push(cwd);
    }

    prefixes.sort();
    prefixes.dedup();
    prefixes.sort_by_key(|p| std::cmp::Reverse(p.to_string_lossy().len()));

    for prefix in prefixes {
        let prefix_string = prefix
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_string();
        let encoded_prefix = encode_project_path(&prefix_string);
        if encoded == encoded_prefix {
            return Some(PathBuf::from(prefix_string));
        }
        if let Some(remaining) = encoded.strip_prefix(&format!("{encoded_prefix}-")) {
            if let Some(result) = decode_by_fs_matching(&PathBuf::from(prefix_string), remaining) {
                return Some(result);
            }
        }
    }
    None
}

/// Encode a single directory name the way Claude Code does (spaces → dashes).
fn encode_segment(name: &str) -> String {
    name.replace(' ', "-")
}

/// Decode an encoded path suffix by matching against real filesystem entries.
/// At each level, enumerate actual directory names, encode each one, and check
/// if it consumes the next encoded segment. Longest valid match wins.
fn decode_by_fs_matching(current_dir: &Path, remaining: &str) -> Option<PathBuf> {
    if remaining.is_empty() {
        return Some(current_dir.to_path_buf());
    }

    if !current_dir.is_dir() {
        return None;
    }

    // Collect filesystem entries whose encoded name matches a prefix of `remaining`
    let mut matches: Vec<(PathBuf, usize)> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(current_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let encoded_seg = encode_segment(&name);

            if remaining == encoded_seg || remaining.starts_with(&format!("{encoded_seg}-")) {
                matches.push((entry.path(), encoded_seg.len()));
            }
        }
    }

    // Greedy: try longest matches first
    matches.sort_by(|a, b| b.1.cmp(&a.1));

    for (path, consumed) in matches {
        let rest_after = &remaining[consumed..];
        // The next '-' (if any) is a path separator between segments
        let next_remaining = rest_after.strip_prefix('-').unwrap_or(rest_after);

        if next_remaining.is_empty() {
            if path.is_dir() {
                return Some(path);
            }
        } else if let Some(result) = decode_by_fs_matching(&path, next_remaining) {
            return Some(result);
        }
    }

    None
}

pub fn encode_project_path(path: &str) -> String {
    // Claude Code encodes: ':\' -> '--' (drive separator), '\'/' -> '-', spaces -> '-'
    // Normalize forward slashes to backslashes first so that 'E:/Claude/test' and
    // 'E:\Claude\test' produce the same encoded name.
    let path = path.replace('/', "\\");
    path.replace(":\\", "--")
        .replace('\\', "-")
        .replace(' ', "-")
}

/// Get the level-1 directory from a project path.
/// E:\projectA → E:\projectA
/// D:\MyCodes\claude-hub → D:\MyCodes
/// D:\MyCodes\Milk Order\all-sys → D:\MyCodes
pub fn get_level1_dir(path: &str) -> Option<String> {
    let path = std::path::Path::new(path);
    let components: Vec<std::path::Component<'_>> = path.components().collect();
    // Need at least: Prefix("D:") + RootDir + one Normal component (e.g., "D:\" + "MyCodes")
    // components: Prefix("D:"), RootDir, Normal("MyCodes"), Normal("claude-hub")
    if components.len() < 3 {
        return None;
    }
    // Build path from prefix + root + first normal component
    let mut result = std::path::PathBuf::new();
    result.push(components[0]); // drive prefix
    result.push(components[1]); // root dir
    result.push(components[2]); // first dir segment
    Some(result.to_string_lossy().to_string())
}

pub fn add_project(path: &str) -> Option<Project> {
    let project_path = Path::new(path);
    if !project_path.is_dir() {
        return None;
    }

    let encoded = encode_project_path(path);

    // Unhide if previously removed
    let _ = crate::hub::unhide_project(&encoded);
    // Persist as manual project
    let _ = crate::hub::add_manual_project(path);

    build_project_from_path(path)
}

fn count_sessions(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path()
                        .extension()
                        .map(|ext| ext == "jsonl")
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

fn get_last_active(dir: &Path) -> Option<String> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext == "jsonl")
                .unwrap_or(false)
        })
        .filter_map(|e| e.metadata().ok()?.modified().ok())
        .max()
        .map(|t| {
            let datetime: chrono::DateTime<chrono::Local> = t.into();
            datetime.format("%Y-%m-%d %H:%M").to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_get_level1_dir() {
        assert_eq!(
            get_level1_dir("D:\\MyCodes\\claude-hub"),
            Some("D:\\MyCodes".to_string())
        );
        assert_eq!(
            get_level1_dir("E:\\projectA"),
            Some("E:\\projectA".to_string())
        );
        assert_eq!(
            get_level1_dir("D:\\MyCodes\\Milk Order\\all-sys"),
            Some("D:\\MyCodes".to_string())
        );
    }

    #[test]
    fn test_encode_project_path() {
        let encoded = encode_project_path("D:\\MyCodes\\claude-hub");
        assert_eq!(encoded, "D--MyCodes-claude-hub");
    }

    #[test]
    fn test_encode_path_forward_slash_same_as_backslash() {
        // Forward-slash paths (e.g. from Open Code's DB) must encode identically
        // to backslash paths so that merge_projects can deduplicate by encoded_name.
        assert_eq!(encode_project_path("E:/Claude/test"), "E--Claude-test");
        assert_eq!(
            encode_project_path("E:/Claude/test"),
            encode_project_path("E:\\Claude\\test")
        );
    }

    #[test]
    fn test_encode_path_with_spaces() {
        assert_eq!(
            encode_project_path("E:\\TestProject - 2"),
            "E--TestProject---2"
        );
    }

    #[test]
    fn test_decode_simple_path() {
        let tmp = std::env::temp_dir().join("test_simple_path");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let path = tmp.to_string_lossy().to_string();
        let encoded = encode_project_path(&path);
        let decoded = decode_project_path(&encoded);
        assert_eq!(decoded, path);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_decode_path_with_spaces() {
        let tmp = std::env::temp_dir().join("Milk Order");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let path = tmp.to_string_lossy().to_string();
        let encoded = encode_project_path(&path);
        let decoded = decode_project_path(&encoded);
        assert_eq!(decoded, path);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_decode_path_with_dashes() {
        let tmp = std::env::temp_dir().join("claude-hub");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let path = tmp.to_string_lossy().to_string();
        let encoded = encode_project_path(&path);
        let decoded = decode_project_path(&encoded);
        assert_eq!(decoded, path);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_decode_path_with_spaces_and_dashes() {
        let parent = std::env::temp_dir().join("My Project");
        let tmp = parent.join("my-sub-dir");
        let _ = fs::remove_dir_all(&parent);
        fs::create_dir_all(&tmp).unwrap();

        let path = tmp.to_string_lossy().to_string();
        let encoded = encode_project_path(&path);
        let decoded = decode_project_path(&encoded);
        assert_eq!(decoded, path);

        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn test_decode_path_space_dash_space() {
        // "TestProject - 2" → encoded "TestProject---2" (space→dash, dash stays, space→dash)
        let tmp = std::env::temp_dir().join("TestProject - 2");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let path = tmp.to_string_lossy().to_string();
        let encoded = encode_project_path(&path);

        // Verify the encoding has triple dash for " - "
        assert!(
            encoded.contains("TestProject---2"),
            "expected triple dash in: {encoded}"
        );

        let decoded = decode_project_path(&encoded);
        assert_eq!(decoded, path);

        let _ = fs::remove_dir_all(&tmp);
    }
}
