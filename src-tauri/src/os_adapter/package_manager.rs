pub const fn get_git_install_command() -> Option<&'static str> {
    #[cfg(target_os = "windows")]
    {
        Some("winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements")
    }
    #[cfg(target_os = "macos")]
    {
        // 如果有 brew，用 brew；否则用 macOS 原生包 xcode-select 弹出安装提示
        Some("if command -v brew >/dev/null 2>&1; then brew install git; else xcode-select --install; fi")
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        None // Linux can be apt, pacman, dnf, etc. Leave it manual.
    }
}

pub const fn get_git_update_command() -> Option<&'static str> {
    #[cfg(target_os = "windows")]
    {
        Some("winget upgrade --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements")
    }
    #[cfg(target_os = "macos")]
    {
        Some("brew upgrade git")
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        None
    }
}

pub const fn get_git_download_url() -> Option<&'static str> {
    #[cfg(target_os = "windows")]
    {
        Some("https://git-scm.com/downloads/win")
    }
    #[cfg(target_os = "macos")]
    {
        Some("https://git-scm.com/downloads/mac")
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Some("https://git-scm.com/downloads/linux")
    }
}
