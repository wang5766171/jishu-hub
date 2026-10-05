; Custom NSIS installer hooks for Jishu Hub

!include /NONFATAL "cli-source.nsh"

; Override the welcome page text（中英并列双语：本文件在 !insertmacro
; MUI_LANGUAGE 之前被引入，顶部 LangString 双语定义会同时落到语言 id 1033
; 且中文覆盖英文——makensis warning 7025/6030 实证，故不用 LangString 机制。
; $_CLICK 在 MUI 语言加载后才展开，此处保留。）
!define MUI_WELCOMEPAGE_TEXT "在安装之前，请先关闭其他 CLI 智能体程序（如 Claude Code、OpenAI Codex、Open Code 等），并退出正在运行的 Jishu Hub（含后台智能体进程）。这将确保安装程序能够更新所需的系统文件，从而避免在安装后重新启动计算机。$\r$\n$\r$\nBefore installing, please close other CLI agent programs (such as Claude Code, OpenAI Codex, Open Code, etc.), and exit the running Jishu Hub (including its background agent processes). This ensures the installer can update necessary system files without requiring a restart after installation.$\r$\n$\r$\n$_CLICK"

; === 升级/卸载防护（v0.9.5 需求10）===
; 场景：旧版曾以管理员身份装在 Program Files 等受保护位置，升级沿用其
; InstallLocation——currentUser 安装/卸载器（不提权）对只读目录删不动/写
; 不进，模板表现为「卸载失败→重弹卸载页→安装报错需管理员」连环模糊失败。
; 防护：①可写性探测+明确指引；②进程清理（含 pi 引擎 node 子进程，
; 按安装路径精确匹配——严格避免误杀用户其他 node 进程）。
Var jishuMsg

; 防护提示文案：运行时按安装器语言（$LANGUAGE）取。不能用顶部 LangString——
; 同上，本文件先于语言注册被引入，${LANG_ENGLISH}/${LANG_SIMPCHINESE} 未定义。
; 1033 = English；其余（本产品仅 2052 简中）走中文默认。
!macro _JishuMsgInstallDenied
  StrCpy $jishuMsg "无法写入安装目录：$\r$\n$INSTDIR$\r$\n$\r$\n常见原因：旧版本曾以管理员身份安装在受保护位置（如 Program Files），或所选目录需要管理员权限，而本安装程序以当前用户身份运行。$\r$\n$\r$\n是否以管理员身份继续安装？（选「是」将以管理员身份安装；选「否」则不安装并退出，稍后也可手动以管理员身份运行安装程序）"
  ${If} $LANGUAGE == 1033
    StrCpy $jishuMsg "Cannot write to the installation folder:$\r$\n$INSTDIR$\r$\n$\r$\nThis usually happens when the previous version was installed to a protected location (e.g. Program Files), or the chosen folder requires administrator rights, while this installer runs as the current user.$\r$\n$\r$\nContinue installing as administrator? (Yes = install as administrator; No = exit without installing, you can also run the installer as administrator manually later)"
  ${EndIf}
!macroend

!macro _JishuMsgUninstallDenied
  StrCpy $jishuMsg "无法卸载，安装目录需要管理员权限：$\r$\n$INSTDIR$\r$\n$\r$\n该目录位于受保护位置（如 Program Files），而卸载程序以当前用户身份运行。$\r$\n$\r$\n是否以管理员身份继续卸载？（选「是」将以管理员身份卸载；选「否」则不卸载并退出，稍后也可到安装目录右键 uninstall.exe 以管理员身份运行）"
  ${If} $LANGUAGE == 1033
    StrCpy $jishuMsg "Cannot uninstall from:$\r$\n$INSTDIR$\r$\n$\r$\nThis folder requires administrator rights (e.g. it is under Program Files), while the uninstaller runs as the current user.$\r$\n$\r$\nContinue uninstalling as administrator? (Yes = uninstall as administrator; No = exit without uninstalling; you can also right-click uninstall.exe and run as administrator later)"
  ${EndIf}
!macroend

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
    ; nsExec 隐藏执行控制台命令（ExecWait 跑 powershell 会闪控制台黑窗——
    ; 本宏在预检/安装/卸载多点位各执行一次，用户实测「很多弹窗一闪而过」）。
    ; 栈上压回 输出+退出码 两个值，Pop 清理即可（无需消费）。
    nsExec::ExecToStack 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\jishu-kill.ps1"'
    Pop $R9
    Pop $R9
    Delete "$PLUGINSDIR\jishu-kill.ps1"
  ${EndIf}
!macroend

; 可写性探测（纯探测，可写压 1 / 不可写压 0，调用方 Pop 后自定处置）。
; 与「提示+中止」拆开：.onGUIInit 预检场景需要 Quit 而非 Abort——Abort 在
; .onGUIInit 回调中行为未定义，Quit 已实测干净退出（退出码 0）。
!macro _JishuProbeInstDirWritable
  ClearErrors
  FileOpen $R8 "$INSTDIR\.jishu-write-probe" w
  ${If} ${Errors}
    Push 0
  ${Else}
    FileClose $R8
    Delete "$INSTDIR\.jishu-write-probe"
    Push 1
  ${EndIf}
!macroend

; 断言式封装（PREINSTALL 钩子用）：不可写 → 明确指引 + 一键提权重跑（选「是」
; 以 runas 重启本安装程序，UAC 确认后由提权实例从向导开始重走；选「否」中止）。
; ExecShell runas 在用户拒绝 UAC 时静默失败——本实例已退出，用户可稍后手动重跑。
!macro _JishuAssertInstDirWritable MSGMACRO
  !insertmacro _JishuProbeInstDirWritable
  Pop $R9
  ${If} $R9 == 0
    !insertmacro ${MSGMACRO}
    MessageBox MB_YESNO|MB_ICONSTOP $jishuMsg IDYES jishu_elevate_inst IDNO jishu_stop_inst
    jishu_elevate_inst:
    ; /D= 带上目录页已选的目标路径，提权实例目录页预填原路径，无需重选
    ExecShell "runas" "$EXEPATH" "/D=$INSTDIR"
    Quit
    jishu_stop_inst:
      Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; 需求10：先清进程（文件占用会卡住解压/删除），再验可写性。
  !insertmacro _JishuKillRunningProcesses
  !insertmacro _JishuAssertInstDirWritable _JishuMsgInstallDenied
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 需求10：卸载侧同防护——先杀进程（否则 POSTUNINSTALL 清理
  ; .jishu-agent 会被运行中的 node 占用卡住），再验目录可写性；
  ; 不可写时引导一键提权重跑卸载器。
  !insertmacro _JishuKillRunningProcesses
  !insertmacro _JishuProbeInstDirWritable
  Pop $R9
  ${If} $R9 == 0
    !insertmacro _JishuMsgUninstallDenied
    MessageBox MB_YESNO|MB_ICONSTOP $jishuMsg IDYES jishu_elevate_un IDNO jishu_stop_un
    jishu_elevate_un:
      ; _?= 使提权实例免复制直跑并明确目标目录（NSIS _?= 模式卸载器无法自删，
      ; 结束后 uninstall.exe 可能残留——下次安装会覆盖，自愈分支不依赖它）
      ExecShell "runas" "$INSTDIR\uninstall.exe" "_?=$INSTDIR"
      Quit
    jishu_stop_un:
      Abort
  ${EndIf}
!macroend

; --- PATH injection for jishu CLI ---

!include LogicLib.nsh
!include WinMessages.nsh
!include WordFunc.nsh
!insertmacro WordFind

; === 升级预检（v0.9.5 需求10 二轮修复：根治「卸载→无法卸载→回卸载页」死循环）===
; 一轮防护（PREINSTALL/PREUNINSTALL）覆盖不到死循环路径：检测到旧版时，
; 模板在「重装选择页」的 leave 函数里直接 ExecWait 注册表登记的**旧卸载器**
; ——旧卸载器（0.9.4/防护前 0.9.5）无任何防护，遇只读目录删除失败 → 模板
; 弹通用「无法卸载」→ 回到选择页 → 循环；而 PREINSTALL 在其后的安装段才
; 执行，该路径下永远走不到。本预检挂 .onGUIInit（MUI 在首个页面前调用，
; 模板未占用该钩子），在进页面前同时完成两件事：
;   ①预杀进程——旧卸载器随后运行时文件已解锁（可写目录的正常升级同样受益）；
;   ②可写性探测——受保护目录（Program Files 等）+普通权限时，在循环发生
;     前给出明确指引并退出，而非放任连环模糊报错。
; 拦截后用户出路：以管理员身份重跑本安装器（预检通过，全程畅通），或按
; 指引以管理员运行旧版 uninstall.exe 卸载后改装用户目录。
; 静默安装（/S）不触发 .onGUIInit，本预检不生效——静默链路由官方更新器
; 使用，不在本需求场景内。
!define MUI_CUSTOMFUNCTION_GUIINIT JishuUpgradePreflight

Function JishuUpgradePreflight
  ; $INSTDIR 已由模板 .onInit 的 RestorePreviousInstallLocation 恢复为旧版
  ; InstallLocation（无旧版时为默认用户目录，全新安装场景不在本函数处理，
  ; 最终目录的兜底探测在 PREINSTALL——目录页可改路径）。
  ${If} ${FileExists} "$INSTDIR\uninstall.exe"
    ; 完整旧安装：预杀进程 + 可写性探测（受保护目录在此拦截，杜绝死循环）。
    !insertmacro _JishuKillRunningProcesses
    !insertmacro _JishuProbeInstDirWritable
    Pop $R9
    ${If} $R9 == 0
      !insertmacro _JishuMsgInstallDenied
      MessageBox MB_YESNO|MB_ICONSTOP $jishuMsg IDYES jishu_elevate_gui IDNO jishu_stop_gui
      jishu_elevate_gui:
      ; /D= 把目标目录带进提权实例：其 .onInit 见 INSTDIR≠占位符会跳过
      ; 默认目录/注册表恢复，目录页直接预填原路径（NSIS 要求 /D= 不带引号
      ; 且为最后一个参数——含空格路径原样传递即可）
      ExecShell "runas" "$EXEPATH" "/D=$INSTDIR"
      Quit
      jishu_stop_gui:
        Quit
    ${EndIf}
  ${Else}
    ; 残破旧安装自愈：注册表仍登记旧版、且**登记目录**（$R8）下卸载器已缺失。
    ; 实测场景（需求10 三轮）：提权卸载清掉了文件与本键之前的时间窗内安装/
    ; 重试，或以其他管理员账户提权卸载——currentUser 卸载器删的是提权账户
    ; 的 HKCU，本用户键残留。此时模板仍会弹重装页，选卸载则 ExecWait 缺失的
    ; 卸载器（通用「无法卸载」循环），选安装则目录页预填只读旧路径被
    ; PREINSTALL 拦截——指引让用户「先卸载旧版本」却已无卸载器可跑，死路。
    ; 自愈 = 删残留键 + 回落默认用户目录，按全新安装继续。
    ; ⚠️ 八轮实证教训：残破判定必须看 $R8 登记目录而非当前 $INSTDIR——后者
    ; 可能只是本次运行另选的目标目录（或 /D= 传入值），误看会把别处**活安装**
    ; 的注册表键当残破删掉，此后旧版检测恒失效、升级不再走卸载流程。
    ; 注：下方两个键路径为硬编码，镜像 nsi 的 ${UNINSTKEY}/${MANUPRODUCTKEY}
    ; （本文件先于这些 define 被引入，无法引用；改名需同步此处）。
    ReadRegStr $R8 SHCTX "Software\jishu-hub\Jishu Hub" ""
    ${If} $R8 != ""
    ${AndIfNot} ${FileExists} "$R8\uninstall.exe"
      DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jishu Hub"
      DeleteRegKey SHCTX "Software\jishu-hub\Jishu Hub"
      ${If} $R8 == $INSTDIR
        ; 尽力清残留目录（常见仅剩 jishu.cmd——POSTINSTALL 自建、不在模板
        ; 卸载清单；只读目录清理失败则残留无害，留待提权清理）。
        Delete "$INSTDIR\jishu.cmd"
        RMDir "$INSTDIR"
        StrCpy $INSTDIR "$LOCALAPPDATA\Jishu Hub"
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

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

  ; POSTINSTALL 自建的 jishu.cmd（jishu CLI shim）不在模板卸载清单，卸载后
  ; 残留导致目录删不掉（实测两轮残留的同一根源）；补删并重试清空目录。
  Delete "$INSTDIR\jishu.cmd"
  RMDir "$INSTDIR"

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
