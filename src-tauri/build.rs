fn main() {
    tauri_build::build();

    // v0.9.2 测试期修复（cargo test 启动即 STATUS_ENTRYPOINT_NOT_FOUND）：
    // tauri-build 的内嵌 manifest（comctl32 v6 依赖）只作用于 bin 目标；lib
    // 测试二进制（app_lib-*.exe）没有 manifest，Windows 加载器绑定 comctl32
    // v5，缺 TaskDialogIndirect 导出（muda/tauri-plugin-dialog）→ 进程启动即
    // 0xc0000139。让 link.exe 为所有目标生成外置 manifest 文件（
    // <exe>.manifest 旁车文件，加载器按名拾取）：测试 exe 因此拿到 v6 依赖；
    // 主程序 bin 已有 tauri 内嵌 manifest（内嵌优先，外置文件被忽略）不受
    // 影响——避免 /MANIFEST:EMBED 与 tauri rc 资源双 manifest 冲突。
    if std::env::var("CARGO_CFG_WINDOWS").is_ok() && cfg!(target_env = "msvc") {
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
             name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
             publicKeyToken='6595b64144ccf1df' language='*' \
             processorArchitecture='*'"
        );
    }
}
