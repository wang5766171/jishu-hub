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
    pub initialized: bool,
}

pub fn scan_projects() -> Vec<Project> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let projects_dir = home.join(".claude").join("projects");

    let mut projects = Vec::new();
    let mut seen_encoded = std::collections::HashSet::new();

    // Scan Claude Code projects
    if projects_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                let encoded_name = entry.file_name().to_string_lossy().to_string();
                if crate::hub::is_project_hidden(&encoded_name).unwrap_or(false) {
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
            if crate::hub::is_project_hidden(&encoded).unwrap_or(false) {
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
    // A project is "initialized" if it has a record in ~/.claude/projects/
    let initialized = project_dir.is_dir();

    Some(Project {
        name,
        path: PathBuf::from(&decoded_path),
        encoded_name: encoded_name.to_string(),
        session_count,
        last_active,
        has_claude_md,
        initialized,
    })
}

pub fn decode_project_path(encoded: &str) -> String {
    // Claude Code encodes paths: remove ':', replace '/' and '\' with '-'.
    // Drive letter + first '\' becomes '--' (e.g., "D:\MyCodes" → "D--MyCodes").
    // Decoding is ambiguous when directory names contain '-' (e.g., "claude-hub").
    // We resolve this by checking if each decoded segment exists on the filesystem.
    if let Some(pos) = encoded.find("--") {
        let drive = &encoded[..pos];
        let rest = &encoded[pos + 2..];
        let parts: Vec<&str> = rest.split('-').collect();
        return resolve_path_from_parts(&format!("{}:\\", drive), &parts);
    }
    encoded.replace('-', "\\")
}

/// Recursively try to build a valid filesystem path from dash-separated segments.
/// At each step, try:
/// 1. Joining segments with literal '-' (handles dirs like "claude-hub")
/// 2. Also try replacing '-' with ' ' in the merged segment (handles dirs like "Milk Order")
fn resolve_path_from_parts(current: &str, remaining: &[&str]) -> String {
    if remaining.is_empty() {
        return current.to_string();
    }

    // Build merged candidates from leading segments joined with '-'
    let mut merged = remaining[0].to_string();
    for i in 0..remaining.len() {
        if i > 0 {
            merged.push('-');
            merged.push_str(remaining[i]);
        }

        // Try the literal merged segment (dashes stay as dashes)
        let candidate = join_path(current, &merged);
        let rest = &remaining[i + 1..];
        if candidate_is_valid(&candidate, rest.is_empty()) {
            let result = resolve_path_from_parts(&candidate, rest);
            if result_is_valid(&result) {
                return result;
            }
        }

        // Also try replacing '-' with ' ' in the merged segment (space decoding)
        let merged_with_spaces = merged.replace('-', " ");
        if merged_with_spaces != merged {
            let candidate_spaced = join_path(current, &merged_with_spaces);
            if candidate_is_valid(&candidate_spaced, rest.is_empty()) {
                let result = resolve_path_from_parts(&candidate_spaced, rest);
                if result_is_valid(&result) {
                    return result;
                }
            }
        }
    }

    // Fallback: join everything with path separator
    join_path(current, &remaining.join("\\"))
}

/// Join two path components, avoiding double backslashes.
fn join_path(base: &str, segment: &str) -> String {
    let base_trimmed = base.trim_end_matches('\\');
    format!("{}\\{}", base_trimmed, segment)
}

fn candidate_is_valid(path: &str, is_final: bool) -> bool {
    let p = std::path::Path::new(path);
    is_final || p.is_dir()
}

fn result_is_valid(result: &str) -> bool {
    Path::new(result).is_dir()
}

pub fn encode_project_path(path: &str) -> String {
    // Claude Code encodes: ':\' -> '--' (drive separator), then all remaining '\' and '/' -> '-'
    let with_drive = path
        .replace(":\\", "--")
        .replace('\\', "-")
        .replace('/', "-");
    with_drive
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
}
