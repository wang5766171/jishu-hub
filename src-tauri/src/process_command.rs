#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
pub fn windows_no_window_creation_flags() -> u32 {
    CREATE_NO_WINDOW
}

pub fn std_no_window(command: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_no_window_creation_flags());
    }
    command
}

pub fn tokio_no_window(command: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(windows_no_window_creation_flags());
    }
    command
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_silent_processes_use_create_no_window() {
        assert_eq!(super::windows_no_window_creation_flags(), 0x08000000);
    }
}
