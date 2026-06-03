; Custom NSIS installer hooks for Jishu Hub

; Override the welcome page text
LangString welcomeText ${LANG_ENGLISH} "Before installing, please close other CLI agent programs (such as Claude Code, OpenAI Codex, Open Code, etc.). This ensures the installer can update necessary system files without requiring a restart after installation.$\r$\n$\r$\n$_CLICK"
LangString welcomeText ${LANG_SIMPCHINESE} "在安装之前，请先关闭其他 CLI 智能体程序（如 Claude Code、OpenAI Codex、Open Code 等）。这将确保安装程序能够更新所需的系统文件，从而避免在安装后重新启动计算机。$\r$\n$\r$\n$_CLICK"

!define MUI_WELCOMEPAGE_TEXT "$(welcomeText)"

; --- PATH injection for jishu CLI ---

!include LogicLib.nsh
!include WinMessages.nsh
!include WordFunc.nsh
!insertmacro WordFind

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
