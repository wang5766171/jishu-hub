; Custom NSIS installer hooks for Jishu Hub

!include /NONFATAL "cli-source.nsh"

; Override the welcome page text
LangString welcomeText ${LANG_ENGLISH} "Before installing, please close other CLI agent programs (such as Claude Code, OpenAI Codex, Open Code, etc.). This ensures the installer can update necessary system files without requiring a restart after installation.$\r$\n$\r$\n$_CLICK"
LangString welcomeText ${LANG_SIMPCHINESE} "在安装之前，请先关闭其他 CLI 智能体程序（如 Claude Code、OpenAI Codex、Open Code 等）。这将确保安装程序能够更新所需的系统文件，从而避免在安装后重新启动计算机。$\r$\n$\r$\n$_CLICK"

!define MUI_WELCOMEPAGE_TEXT "$(welcomeText)"

; --- PATH injection for jishu CLI ---

!include LogicLib.nsh
!include WinMessages.nsh
!include WordFunc.nsh
!insertmacro WordFind

Section -InstallJishuCli
  ; Copy the separately built CLI into the install directory. The GUI launches
  ; this binary for the jishu-self agent bridge.
  !ifdef JISHU_CLI_SOURCE
    SetOutPath "$INSTDIR"
    File "/oname=jishu-cli.exe" "${JISHU_CLI_SOURCE}"
  !endif
SectionEnd

Section -AddToPath
  ; Add install directory to PATH so `jishu` CLI is available.
  ; Tauri includes installer hooks before INSTALLMODE is defined. The generated
  ; NSIS installer is currentUser, so register the CLI in the user's PATH.
  ReadRegStr $0 HKCU "Environment" "Path"

  StrCpy $1 "$0"
  StrCpy $2 "0"
  ${Do}
    ${If} $1 == ""
      ${Break}
    ${EndIf}
    StrCpy $3 $1 1
    ${If} $3 == ";"
      StrCpy $1 $1 "" 1
      ${Continue}
    ${EndIf}
    ClearErrors
    ${WordFind} "$1" ";" "+1" $4
    ${If} ${Errors}
      StrCpy $4 "$1"
      StrCpy $1 ""
    ${Else}
      StrLen $5 "$4"
      IntOp $5 $5 + 1
      StrCpy $1 "$1" "" $5
    ${EndIf}
    ${If} $4 == "$INSTDIR"
      StrCpy $2 "1"
      ${Break}
    ${EndIf}
  ${Loop}

  ${If} $0 == ""
    WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
  ${ElseIf} $2 != "1"
    WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR"
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
SectionEnd

; === 关键修复（v0.7.2 需求 5 反复失败的根因）===
; 之前把 agent 安装写成裸 `Section -InstallJishuAgent`，而 installer.nsh 在脚本最顶部被
; !include，裸 Section 声明顺序排在 Tauri 的 `Section Install`（真正解压 jishu-hub.exe 与
; pi-bundle 的段）之前，导致 ExecWait 运行时 exe 尚未解压到 $INSTDIR，CreateProcess 失败，
; $0 保持上一段残留的 PATH 值，agent-install.log 从不生成（与"ExecWait 不支持带引号路径"
; 无关——引号写法本身是对的）。
; 正确做法：放进 NSIS_HOOK_POSTINSTALL。Tauri 在生成的 installer.nsi 中于 `Section Install`
; 内部、所有 File 解压完成后才 !insertmacro 本宏，此时 jishu-hub.exe 必定已存在。
!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installing Jishu Agent runtime..."
  ; 用 hub.exe --install-agent（Rust copy_dir_recursive 复制 pi-bundle，手动验证成功）。
  ; 引号写法：外层单引号给 NSIS，内层双引号保护含空格的 $INSTDIR 路径。
  ExecWait '"$INSTDIR\jishu-hub.exe" --install-agent' $0
  ; jishu.cmd shim
  FileOpen $1 "$INSTDIR\jishu.cmd" w
  FileWrite $1 '@echo off$\r$\n'
  FileWrite $1 'set PI_SKIP_VERSION_CHECK=1$\r$\n'
  FileWrite $1 'node "%USERPROFILE%\.jishu-agent\packages\coding-agent\dist\cli.js" %*$\r$\n'
  FileClose $1
!macroend

Section -un.RemoveFromPath
  ; Remove from PATH on uninstall
  ReadRegStr $0 HKCU "Environment" "Path"

  StrCpy $1 "$0"
  StrCpy $2 ""

  ${Do}
    ${If} $1 == ""
      ${Break}
    ${EndIf}
    StrCpy $3 $1 1
    ${If} $3 == ";"
      StrCpy $1 $1 "" 1
      ${Continue}
    ${EndIf}
    ClearErrors
    ${WordFind} "$1" ";" "+1" $4
    ${If} ${Errors}
      StrCpy $4 "$1"
      StrCpy $1 ""
    ${Else}
      StrLen $5 "$4"
      IntOp $5 $5 + 1
      StrCpy $1 "$1" "" $5
    ${EndIf}
    ${If} $4 != "$INSTDIR"
      ${IfThen} $2 != "" ${|} StrCpy $2 "$2;" ${|}
      StrCpy $2 "$2$4"
    ${EndIf}
  ${Loop}

  WriteRegExpandStr HKCU "Environment" "Path" "$2"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
SectionEnd

!macro NSIS_HOOK_POSTUNINSTALL
  ; v0.7.2 需求 5：卸载时（非更新模式）无条件清理 jishu agent 本体（packages/
  ; node_modules，由 hub 安装），避免残留与新版冲突。用户数据（settings/sessions/mcp）
  ; 保留，由下方"删除用户数据"勾选决定是否一并清理。
  ${If} $UpdateMode <> 1
    RMDir /r "$PROFILE\.jishu-agent\packages"
    RMDir /r "$PROFILE\.jishu-agent\node_modules"
  ${EndIf}
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$PROFILE\.jishu-hub"
    RMDir /r "$PROFILE\.jishu-agent"
    RMDir /r "$APPDATA\jishu-hub"
    RMDir /r "$LOCALAPPDATA\jishu-hub"
  ${EndIf}
!macroend
