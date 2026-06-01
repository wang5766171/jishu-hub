; Custom NSIS installer hooks for Jishu Hub

; Override the welcome page text
LangString welcomeText ${LANG_ENGLISH} "Before installing, please close other CLI agent programs (such as Claude Code, OpenAI Codex, Open Code, etc.). This ensures the installer can update necessary system files without requiring a restart after installation.$\r$\n$\r$\n$_CLICK"
LangString welcomeText ${LANG_SIMPCHINESE} "在安装之前，请先关闭其他 CLI 智能体程序（如 Claude Code、OpenAI Codex、Open Code 等）。这将确保安装程序能够更新所需的系统文件，从而避免在安装后重新启动计算机。$\r$\n$\r$\n$_CLICK"

!define MUI_WELCOMEPAGE_TEXT "$(welcomeText)"

; --- PATH injection for jishu CLI ---

Section -AddToPath
  ; Add install directory to PATH so `jishu` CLI is available
  EnVar::SetHKLM
  EnVar::AddValue "Path" "$INSTDIR"
SectionEnd

Section -un.RemoveFromPath
  ; Remove from PATH on uninstall
  EnVar::SetHKLM
  EnVar::DeleteValue "Path" "$INSTDIR"
SectionEnd
