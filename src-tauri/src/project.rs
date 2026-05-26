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
    // Claude Code encodes paths: ':\' → '--', then '\'/' → '-', and spaces → '-'.
    // This makes decoding ambiguous (e.g., "TestProject---2" could be "TestProject - 2",
    // "TestProject-- 2", etc.). We resolve by matching against actual filesystem entries.
    if let Some(pos) = encoded.find("--") {
        let drive = &encoded[..pos];
        let rest = &encoded[pos + 2..];
        let base = format!("{}:\\", drive);

        let result = decode_by_fs_matching(&base, rest);
        if result_is_valid(&result) {
            return result;
        }

        // Fallback for deleted/missing directories
        join_path(&base, &rest.replace('-', "\\"))
    } else {
        encoded.replace('-', "\\")
    }
}

/// Encode a single directory name the way Claude Code does (spaces → dashes).
fn encode_segment(name: &str) -> String {
    name.replace(' ', "-")
}

/// Decode an encoded path suffix by greedily matching against filesystem entries.
/// At each level, enumerate actual directory names, encode each one, and check
/// if it matches a prefix of the remaining encoded string. Longest match wins.
fn decode_by_fs_matching(current_dir: &str, remaining: &str) -> String {
    if remaining.is_empty() {
        return current_dir.to_string();
    }

    let dir = Path::new(current_dir);
    if !dir.is_dir() {
        return join_path(current_dir, &remaining.replace('-', "\\"));
    }

    // Collect filesystem entries whose encoded name matches a prefix of `remaining`
    let mut matches: Vec<(String, usize)> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let encoded_seg = encode_segment(&name);

            if remaining.starts_with(&encoded_seg) {
                matches.push((name, encoded_seg.len()));
            }
        }
    }

    // Greedy: try longest matches first
    matches.sort_by(|a, b| b.1.cmp(&a.1));

    for (name, consumed) in matches {
        let rest_after = &remaining[consumed..];
        // The next '-' (if any) is a path separator between segments
        let next_remaining = rest_after.strip_prefix('-').unwrap_or(rest_after);
        let next_dir = join_path(current_dir, &name);

        if next_remaining.is_empty() {
            if Path::new(&next_dir).is_dir() {
                return next_dir;
            }
        } else {
            let result = decode_by_fs_matching(&next_dir, next_remaining);
            if result_is_valid(&result) {
                return result;
            }
        }
    }

    // No filesystem match — fall back to naive decode
    join_path(current_dir, &remaining.replace('-', "\\"))
}

/// Join two path components, avoiding double backslashes.
fn join_path(base: &str, segment: &str) -> String {
    let base_trimmed = base.trim_end_matches('\\');
    format!("{}\\{}", base_trimmed, segment)
}

fn result_is_valid(result: &str) -> bool {
    Path::new(result).is_dir()
}

pub fn encode_project_path(path: &str) -> String {
    // Claude Code encodes: ':\' -> '--' (drive separator), '\'/' -> '-', spaces -> '-'
    path.replace(":\\", "--")
        .replace('\\', "-")
        .replace('/', "-")
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
        assert!(encoded.contains("TestProject---2"), "expected triple dash in: {encoded}");

        let decoded = decode_project_path(&encoded);
        assert_eq!(decoded, path);

        let _ = fs::remove_dir_all(&tmp);
    }
}
