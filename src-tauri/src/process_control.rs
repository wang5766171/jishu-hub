pub fn terminate_process_tree(process_id: u32) -> Result<(), String> {
    if process_id == 0 {
        return Err("Invalid process id".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("taskkill")
            .args(["/PID", &process_id.to_string(), "/T", "/F"])
            .output()
            .map_err(|e| format!("Failed to run taskkill: {e}"))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if stderr.is_empty() { stdout } else { stderr };
        Err(if message.is_empty() {
            format!("taskkill failed for pid {process_id}")
        } else {
            message
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = std::process::Command::new("pkill")
            .args(["-TERM", "-P", &process_id.to_string()])
            .output()
            .map_err(|e| format!("Failed to run pkill: {e}"))?;
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &process_id.to_string()])
            .output();

        if output.status.success() {
            Ok(())
        } else {
            Ok(())
        }
    }
}
