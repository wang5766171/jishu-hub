#[tauri::command]
pub fn check_cli_symlink() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        // Handled by NSIS installer
        Ok(true)
    }
    #[cfg(target_os = "macos")]
    {
        let link_path = std::path::Path::new("/usr/local/bin/jishu");
        if !link_path.exists() {
            return Ok(false);
        }
        match std::fs::read_link(link_path) {
            Ok(target) => {
                // check if it points to an app bundle
                Ok(target.to_string_lossy().contains("Jishu Hub.app"))
            }
            Err(_) => Ok(false)
        }
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Ok(true)
    }
}

#[tauri::command]
pub fn install_cli_symlink() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let exe_path = std::env::current_exe().map_err(|e| format!("Could not get current exe: {}", e))?;
        // exe is likely in Jishu Hub.app/Contents/MacOS/jishu-hub
        let app_dir = exe_path.parent().ok_or("No parent dir")?;
        let cli_bin = app_dir.join("jishu");
        
        if !cli_bin.exists() {
            return Err("jishu CLI binary not found in app bundle. It needs to be bundled as an externalBin.".into());
        }

        let link_path = std::path::Path::new("/usr/local/bin/jishu");
        
        // Ensure /usr/local/bin exists
        let bin_dir = std::path::Path::new("/usr/local/bin");
        if !bin_dir.exists() {
            std::fs::create_dir_all(bin_dir).map_err(|e| format!("Failed to create /usr/local/bin: {}. Try manually creating it or check permissions.", e))?;
        }

        // Remove existing if any
        if link_path.exists() || std::fs::symlink_metadata(link_path).is_ok() {
            std::fs::remove_file(link_path).map_err(|e| format!("Failed to remove existing symlink: {}. Might need sudo.", e))?;
        }

        // Try to create the symlink
        if let Err(e) = std::os::unix::fs::symlink(&cli_bin, link_path) {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                // Elevate via osascript
                let script = format!(
                    "do shell script \"mkdir -p /usr/local/bin && rm -f /usr/local/bin/jishu && ln -sf '{}' /usr/local/bin/jishu\" with administrator privileges",
                    cli_bin.display()
                );
                let output = std::process::Command::new("osascript")
                    .args(["-e", &script])
                    .output()
                    .map_err(|e| format!("Failed to spawn osascript: {}", e))?;
                
                if !output.status.success() {
                    return Err(format!("Failed to elevate permissions: {}", String::from_utf8_lossy(&output.stderr)));
                }
            } else {
                return Err(format!("Failed to create symlink: {}", e));
            }
        }

        Ok(())
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Err("Not supported on this OS".into())
    }
}
