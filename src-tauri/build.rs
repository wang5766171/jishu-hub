fn main() {
    let pkg_path = std::path::Path::new("../third_party/pi/packages/coding-agent/package.json");
    if let Ok(content) = std::fs::read_to_string(pkg_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(v) = json["version"].as_str() {
                println!("cargo:rustc-env=PI_AGENT_VERSION={}", v);
            }
        }
    }
    tauri_build::build()
}
