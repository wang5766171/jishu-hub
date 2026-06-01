#[test]
fn no_pi_agent_rust_references() {
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
                    for forbidden in &["pi_agent_rust", "asupersync", "rich_rust"] {
                        if content.contains(forbidden) {
                            violations.push(format!(
                                "{}: contains forbidden string '{}'",
                                path.display(),
                                forbidden
                            ));
                        }
                    }
                }
            }
        }
    }

    check_dir(&src_dir, &mut violations);
    assert!(
        violations.is_empty(),
        "License isolation violations:\n{}",
        violations.join("\n")
    );
}
