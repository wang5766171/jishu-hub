; Custom NSIS installer hooks for Jishu Hub

!include /NONFATAL "cli-source.nsh"

; Override the welcome page text
LangString welcomeText ${LANG_ENGLISH} "Before installing, please close other CLI agent programs (such as Claude Code, OpenAI Codex, Open Code, etc.), and exit the running Jishu Hub (including its background agent processes). This ensures the installer can update necessary system files without requiring a restart after installation.$\r$\n$\r$\n$_CLICK"
LangString welcomeText ${LANG_SIMPCHINESE} "在安装之前，请先关闭其他 CLI 智能体程序（如 Claude Code、OpenAI Codex、Open Code 等），并退出正在运行的 Jishu Hub（含后台智能体进程）。这将确保安装程序能够更新所需的系统文件，从而避免在安装后重新启动计算机。$\r$\n$\r$\n$_CLICK"

!define MUI_WELCOMEPAGE_TEXT "$(welcomeText)"

; === 升级/卸载防护（v0.9.5 需求10）===
; 场景：旧版曾以管理员身份装在 Program Files 等受保护位置，升级沿用其
; InstallLocation——currentUser 安装/卸载器（不提权）对只读目录删不动/写
; 不进，模板表现为「卸载失败→重弹卸载页→安装报错需管理员」连环模糊失败。
; 防护：①可写性探测+明确指引；②进程清理（含 pi 引擎 node 子进程，
; 按安装路径精确匹配——严格避免误杀用户其他 node 进程）。
LangString jishuInstallDirDenied ${LANG_ENGLISH} "Cannot write to the installation folder:$\r$\n$INSTDIR$\r$\n$\r$\nThis usually happens when the previous version was installed to a protected location (e.g. Program Files) with administrator rights, while this installer runs as the current user.$\r$\n$\r$\nPlease re-run this installer as administrator, or uninstall the old version first and install to your user folder (default path)."
LangString jishuInstallDirDenied ${LANG_SIMPCHINESE} "无法写入安装目录：$\r$\n$INSTDIR$\r$\n$\r$\n常见原因：旧版本曾以管理员身份安装在受保护位置（如 Program Files），而本安装程序以当前用户身份运行。$\r$\n$\r$\n请以管理员身份重新运行本安装程序；或先卸载旧版本，再将 Jishu Hub 安装到用户目录（默认路径）。"
LangString jishuUninstallDirDenied ${LANG_ENGLISH} "Cannot uninstall from:$\r$\n$INSTDIR$\r$\n$\r$\nThis folder requires administrator rights (e.g. it is under Program Files), while the uninstaller runs as the current user.$\r$\n$\r$\nPlease run the uninstaller as administrator: right-click uninstall.exe in the installation folder and choose 'Run as administrator'."
LangString jishuUninstallDirDenied ${LANG_SIMPCHINESE} "无法卸载，安装目录需要管理员权限：$\r$\n$INSTDIR$\r$\n$\r$\n该目录位于受保护位置（如 Program Files），而卸载程序以当前用户身份运行。$\r$\n$\r$\n请以管理员身份运行卸载程序：到安装目录下右键 uninstall.exe，选择「以管理员身份运行」。"

; 进程清理（安装/卸载双侧复用）：hub 主进程按进程名杀（名字唯一）；
; pi 引擎 node 子进程按安装路径匹配（$$_ / $$env 为 NSIS 的 $ 字面转义，
; 避免被当作 NSIS 变量展开）。
!macro _JishuKillRunningProcesses
  InitPluginsDir
  ClearErrors
  FileOpen $R8 "$PLUGINSDIR\jishu-kill.ps1" w
  ${IfNot} ${Errors}
    FileWrite $R8 'Stop-Process -Name "jishu-hub" -Force -ErrorAction SilentlyContinue$\r$\n'
    FileWrite $R8 'Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like "$$env:USERPROFILE\.jishu-agent\bin\*" } | Stop-Process -Force -ErrorAction SilentlyContinue$\r$\n'
    FileClose $R8
    ExecWait 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\jishu-kill.ps1"' $R9
    Delete "$PLUGINSDIR\jishu-kill.ps1"
  ${EndIf}
!macroend

; 可写性探测（双侧复用）：探测失败 = 目标目录不可写 → 明确指引后中止，
; 好过连环模糊失败。$ERRMSG 为调用方传入的 LangString 名。
!macro _JishuAssertInstDirWritable ERRMSG
  ClearErrors
  FileOpen $R8 "$INSTDIR\.jishu-write-probe" w
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "${ERRMSG}"
    Abort
  ${EndIf}
  FileClose $R8
  Delete "$INSTDIR\.jishu-write-probe"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; 需求10：先清进程（文件占用会卡住解压/删除），再验可写性。
  !insertmacro _JishuKillRunningProcesses
  !insertmacro _JishuAssertInstDirWritable `$(jishuInstallDirDenied)`
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 需求10：卸载侧同防护——先杀进程（否则 POSTUNINSTALL 清理
  ; .jishu-agent 会被运行中的 node 占用卡住），再验目录可写性。
  !insertmacro _JishuKillRunningProcesses
  !insertmacro _JishuAssertInstDirWritable `$(jishuUninstallDirDenied)`
!macroend

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
  ; ── 卸载清除边界（用户数据保护，与 Rust 侧 paths.rs/hub_home() 对齐）──
  ;
  ; 【hub 管理的本体（可随重装恢复，未勾选也可清）】
  ;   $PROFILE\.jishu-agent\packages      pi runtime 本体（POSTINSTALL --install-agent 复制）
  ;   $PROFILE\.jishu-agent\node_modules  pi-bundle 依赖树（同上）
  ;
  ; 【用户数据目录（仅勾选「删除应用数据」才清；未勾选时严禁触碰）】
  ;   $PROFILE\.jishu-agent\agent\       Pi 运行数据：settings.json / models.json /
  ;                                     mcp.json / auth.json / sessions\ / skills\（用户与
  ;                                     分发 skill）/ extensions\（用户导入扩展）/ backups\ /
  ;                                     npm\（官方扩展，重装自愈）/ missions\ / run-history
  ;   $PROFILE\.jishu-hub\               hub 数据根：agents\（清单）/ plugins\（目录形式
  ;                                     插件与 skill 源）/ plugins.json / plugins-config.json /
  ;                                     agent-tools.json / session-tools.json /
  ;                                     skill-deploy.json（分发归属）/ settings.json /
  ;                                     agent-sessions\ / memory.db / approval.db
  ;   $APPDATA\jishu-hub, $LOCALAPPDATA\jishu-hub   任务会话库 taskstore.db 等
  ;   $APPDATA\com.jishu-hub.app 等标识符目录   Tauri 模板在勾选时自清（非本 hook）
  ${If} $UpdateMode <> 1
    ; 仅本体：hub 安装器写入、可重装恢复的 runtime 目录。
    RMDir /r "$PROFILE\.jishu-agent\packages"
    RMDir /r "$PROFILE\.jishu-agent\node_modules"
    ; 注意：不删 $PROFILE\.jishu-agent\agent ——其中的 skills\/extensions\/
    ; sessions\ 等均为用户数据（历史版本曾因插件加载链 bug 导致分发 skill
    ; 被回收误删，已在校验/加载侧修复；卸载器不碰用户目录）。
  ${EndIf}
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$PROFILE\.jishu-hub"
    RMDir /r "$PROFILE\.jishu-agent"
    RMDir /r "$APPDATA\jishu-hub"
    RMDir /r "$LOCALAPPDATA\jishu-hub"
  ${EndIf}
!macroend
