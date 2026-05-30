pub fn terminate_process_tree(process_id: u32) -> Result<(), String> {
    if process_id == 0 {
        return Err("Invalid process id".to_string());
    }

    if !is_process_running(process_id) {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("taskkill");
        let output = crate::process_command::std_no_window(command.args([
            "/PID",
            &process_id.to_string(),
            "/T",
            "/F",
        ]))
        .output()
        .map_err(|e| format!("Failed to run taskkill: {e}"))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if stderr.is_empty() { stdout } else { stderr };
        if !is_process_running(process_id) {
            return Ok(());
        }

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

pub fn is_process_running(process_id: u32) -> bool {
    if process_id == 0 {
        return false;
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("tasklist");
        let Ok(output) = crate::process_command::std_no_window(command.args([
            "/FI",
            &format!("PID eq {process_id}"),
            "/NH",
        ]))
        .output() else {
            return false;
        };
        if !output.status.success() {
            return false;
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.contains(&process_id.to_string()))
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("kill")
            .args(["-0", &process_id.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}
