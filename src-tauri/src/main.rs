// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;

fn main() {
    setup_panic_hook();
    // v0.7.2 需求 5：NSIS 安装器在 POSTINSTALL 阶段以 `--install-agent` 调用本程序，
    // 把内嵌 pi-bundle 装到 ~/.jishu-agent。此模式不启动 GUI，装完即退出。
    if std::env::args().any(|a| a == "--install-agent") {
        let code = app_lib::run_install_agent_cli();
        std::process::exit(code);
    }
    println!("=== JISHU HUB MAIN STARTING ===");
    app_lib::run();
    println!("=== JISHU HUB MAIN EXITED ===");
}

/// 安装全局 panic hook：把 panic 信息 + 调用栈落盘到
/// `<data_dir>/jishu-hub/crash-<timestamp>.log`，便于事后定位启动期崩溃
/// （v0.7.2 需求 1 / M1.7）。
///
/// release 模式下 `windows_subsystem = "windows"`，没有控制台，未落盘的 panic
/// 会变成无栈闪退；本 hook 保证至少留下一份可追溯的崩溃日志。落盘后再把
/// 信息交回默认 hook（dev 模式下仍打印到 stderr）。
fn setup_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(|s| s.as_str()))
            .unwrap_or("<non-string panic payload>");
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        // force_capture 在非 panic 线程取栈；RUST_BACKTRACE 控制其详略。
        let backtrace = std::backtrace::Backtrace::force_capture();
        let now = chrono::Local::now();
        let report = format!(
            "Jishu Hub panic at {}\n  payload: {}\n  location: {}\n\n--- backtrace ---\n{}\n",
            now.format("%Y-%m-%d %H:%M:%S"),
            payload,
            location,
            backtrace
        );

        if let Some(dir) = dirs::data_dir() {
            let crash_dir = dir.join("jishu-hub");
            let _ = std::fs::create_dir_all(&crash_dir);
            let path = crash_dir.join(format!("crash-{}.log", now.format("%Y%m%d-%H%M%S")));
            let _ = std::fs::write(&path, &report);
            let _ = writeln!(
                std::io::stderr(),
                "PANIC report written to {}:\n{}",
                path.display(),
                report
            );
        } else {
            let _ = writeln!(
                std::io::stderr(),
                "PANIC (no data_dir available):\n{}",
                report
            );
        }

        default_hook(info);
    }));
}
