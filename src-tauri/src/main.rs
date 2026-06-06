// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    println!("=== JISHU HUB MAIN STARTING ===");
    app_lib::run();
    println!("=== JISHU HUB MAIN EXITED ===");
}
