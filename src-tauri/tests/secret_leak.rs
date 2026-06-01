/// Verify that API keys and secrets are never hardcoded in source code.
/// ModelPreset stores api_key as Option<String> (user-provided, persisted to
/// models.json) and api_key_env as fallback. Source code must not contain
/// literal key values.
#[test]
fn no_api_keys_in_source() {
    let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut violations = Vec::new();

    fn check_dir(dir: &std::path::Path, violations: &mut Vec<String>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    check_dir(&path, violations);
                } else if path.extension().map(|e| e == "rs").unwrap_or(false) {
                    let content = std::fs::read_to_string(&path).unwrap_or_default();
                    for line in content.lines() {
                        // Look for literal "sk-" key values (quoted string starting with sk-)
                        // False positives from starts_with / task-notification / ask are excluded
                        if line.contains("\"sk-") && !line.contains("test") && !line.contains("example") && !line.contains("placeholder") {
                            violations.push(format!("{}: possible hardcoded API key: {}", path.display(), line.trim()));
                        }
                    }
                }
            }
        }
    }

    check_dir(&src_dir, &mut violations);
    assert!(
        violations.is_empty(),
        "Potential hardcoded secrets in source:\n{}",
        violations.join("\n")
    );
}

#[test]
fn model_preset_stores_key_safely() {
    use std::path::Path;
    let config_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("llm").join("config.rs");
    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).unwrap();
        // api_key is Option<String> (nullable, skip_serializing_if none)
        assert!(
            content.contains("skip_serializing_if") && content.contains("api_key"),
            "api_key field must use skip_serializing_if to avoid writing nulls"
        );
    }
}
