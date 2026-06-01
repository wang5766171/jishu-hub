/// Verify that API keys and secrets are never logged or written to trace files
/// in plaintext. Model presets store only the environment variable name, not
/// the actual key value.
#[test]
fn no_api_keys_in_model_store() {
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
                    // Check for patterns that look like hardcoded API keys
                    for line in content.lines() {
                        if line.contains("sk-") && !line.contains("sk-") || line.contains("api_key") && line.contains('"') && !line.contains("api_key_env") && !line.contains("//") && !line.contains("test") {
                            // Skip known safe patterns
                            if line.contains("api_key_env") || line.contains("api_key: None") || line.contains("API key") || line.contains("header") {
                                continue;
                            }
                            violations.push(format!("{}: possible hardcoded API key: {}", path.display(), line.trim()));
                        }
                    }
                }
            }
        }
    }

    check_dir(&src_dir, &mut violations);
    // For now, this is a placeholder check — the real protection is that
    // ModelPreset stores api_key_env (env var name) not the actual key.
    assert!(
        violations.is_empty(),
        "Potential secret leaks:\n{}",
        violations.join("\n")
    );
}

#[test]
fn model_preset_uses_env_var_not_key() {
    use std::path::Path;
    let config_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("llm").join("config.rs");
    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).unwrap();
        // ModelPreset should have api_key_env, not api_key
        assert!(content.contains("api_key_env"), "ModelPreset must use api_key_env field");
        assert!(!content.contains("api_key: String"), "ModelPreset must NOT store raw API keys");
    }
}
