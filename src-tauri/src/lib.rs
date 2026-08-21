mod acp;
mod acp_runtime;
mod agent;
mod agent_runtime;
mod chat;
mod cli_runtime;
mod codex_app_server_runtime;
mod command;
mod commands;
mod config;
mod dialog_commands;
mod history;
mod hub;
mod image;
mod llm;
mod orchestrator;
pub mod os_adapter;
mod pi_rpc_runtime;
mod process_command;
mod process_control;
mod project;
mod project_config;
mod session;
mod task_launch;
mod task_plan;
mod util;

#[cfg(feature = "cli")]
pub mod cli;

use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};

pub struct AppState {
    pub registry: Arc<agent::AgentRegistry>,
    #[cfg(feature = "orchestrator")]
    pub task_service: std::sync::Mutex<orchestrator::TaskService>,
}

/// 安全访问 AppState：若 Mutex 中毒（某持锁线程 panic），强制恢复内部数据继续
/// 服务而非返回错误（v0.7.2 需求 1 / M1.6）。中毒本身说明发生过 panic，根源仍需
/// 配合 panic 日志排查；此为兜底，避免单点 panic 传染为全功能瘫痪。
pub(crate) fn with_app_state<T>(
    state: &tauri::State<'_, Mutex<AppState>>,
    f: impl FnOnce(&AppState) -> T,
) -> Result<T, String> {
    let guard = state.lock().unwrap_or_else(|poisoned| {
        log::error!("AppState lock 中毒，已强制恢复（曾有持锁线程 panic）");
        poisoned.into_inner()
    });
    Ok(f(&guard))
}

// IPC 命令按领域拆分至 commands/ 目录（v0.7.3 需求 1），此处 glob 引入供
// generate_handler 注册；main.rs 仍通过 lib 根路径调用 run_install_agent_cli。
pub use commands::agent_install::run_install_agent_cli;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 注册日志后端：pi_rpc_runtime 等模块的 log::info!/warn! 才会真正输出。
        // dev 模式（npm run tauri dev）打印到终端，release 模式写入日志文件，
        // 便于排查 Pi RPC 会话卡死等运行时问题（此前 tauri_plugin_log 虽在依赖里
        // 但未注册，导致所有 log 调用被静默丢弃）。
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let __setup_t0 = std::time::Instant::now();
            let _ = hub::migrate_v0_5_0();
            // Phase 1: 自动注册 Conductor 扩展 + skill pack + 删除旧 skill
            task_plan::ensure_conductor_extension();
            // 自动部署 request_user_input 扩展（conductor 的 discuss/plan 阶段依赖此工具）
            task_plan::ensure_request_user_input_extension();
            // 部署 session-context 扩展（session_id 注入 system prompt，取代 user message 注入）
            task_plan::ensure_session_context_extension();
            let registry = Arc::new(agent::AgentRegistry::new());
            // v0.7.0：全局 active agent 已移除（需求一：智能体切换去全局化）。
            // 各模块按自身作用域选择 agent，通过 agent_id 入参显式指定；
            // 会话与智能体在 Session 层绑定。启动时不再加载/设置全局 active。
            // Mirror orchestrator node-agent events onto the same `agent-event`
            // channel the chat path uses, so a task node session streams live in
            // the UI through the identical streamStore pipeline instead of a
            // bespoke refresh mechanism. The orchestrator core still never sees
            // an `AppHandle` (design §3.1/D4) — it only holds this closure.
            #[cfg(feature = "orchestrator")]
            let task_service = {
                let event_app = app.handle().clone();
                let event_sink: crate::orchestrator::runtime_bridge::NodeEventSink =
                    Arc::new(move |events, session_id: &str, agent_id: &str| {
                        let chunks: Vec<crate::cli_runtime::AgentStreamChunk> = events
                            .iter()
                            .filter_map(|event| {
                                let data = serde_json::to_value(event).ok()?;
                                Some(crate::cli_runtime::AgentStreamChunk {
                                    agent_id: agent_id.to_string(),
                                    session_id: session_id.to_string(),
                                    event_type: event.event_type().to_string(),
                                    data,
                                })
                            })
                            .collect();
                        if !chunks.is_empty() {
                            let _ = event_app.emit("agent-event", &chunks);
                        }
                    });
                // Mirror a resolved node-session ACP control into the GUI chat
                // state so `respond_chat_interaction` / `steer_chat` /
                // `resolve_chat_permission` find it by session_id. Without this,
                // answering an agent's mid-turn question during the execution
                // phase failed with "No active ACP session found".
                let reg_app = app.handle().clone();
                let acp_register: crate::orchestrator::runtime_bridge::NodeAcpRegister = Arc::new(
                    move |session_id: &str,
                          agent_id: &str,
                          control: crate::acp_runtime::AcpControl| {
                        if let Ok(mut s) =
                            reg_app.state::<std::sync::Mutex<chat::ChatState>>().lock()
                        {
                            match s.processes.get_mut(session_id) {
                                Some(proc) if proc.acp.is_none() => {
                                    proc.acp = Some(control);
                                }
                                None => {
                                    s.processes.insert(
                                        session_id.to_string(),
                                        chat::ChatProcess {
                                            agent_id: agent_id.to_string(),
                                            process_id: 0,
                                            stdin: None,
                                            acp: Some(control),
                                        },
                                    );
                                }
                                _ => {}
                            }
                        }
                    },
                );
                std::sync::Mutex::new(
                    crate::orchestrator::TaskService::open_default_with_event_sink(
                        registry.clone(),
                        event_sink,
                        acp_register,
                    )?,
                )
            };
            app.manage(Mutex::new(AppState {
                registry,
                #[cfg(feature = "orchestrator")]
                task_service,
            }));
            app.manage(std::sync::Mutex::new(chat::ChatState::new()));
            if let Ok(pinned) = hub::load_always_on_top() {
                if pinned {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.set_always_on_top(true);
                    }
                }
            }
            log::info!("[startup] setup 闭包总耗时: {:?}", __setup_t0.elapsed());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agents::list_agents,
            commands::projects::scan_projects,
            commands::projects::list_project_files,
            commands::projects::add_project,
            commands::projects::remove_project,
            commands::sessions::list_sessions,
            commands::sessions::get_session_messages,
            commands::sessions::delete_agent_session,
            commands::sessions::persist_interaction_blocks,
            commands::sessions::persist_partial_assistant,
            commands::sessions::read_text_file,
            commands::sessions::get_session_names,
            commands::sessions::rename_session,
            commands::sessions::delete_session_name,
            commands::config::load_config,
            commands::config::load_raw_config,
            commands::config::save_raw_config,
            commands::config::load_history,
            commands::config::save_config,
            commands::config::get_models_config,
            commands::config::set_models_config,
            commands::config::get_active,
            commands::config::set_active,
            commands::config::list_backups,
            commands::config::restore_backup,
            dialog_commands::export_config_dialog,
            dialog_commands::import_config_dialog,
            dialog_commands::export_raw_config_dialog,
            commands::settings::load_language,
            commands::settings::save_language,
            commands::settings::load_always_on_top,
            commands::settings::toggle_always_on_top,
            commands::settings::load_theme,
            commands::settings::save_theme,
            commands::settings::load_last_project,
            commands::settings::open_url,
            commands::settings::save_last_project,
            commands::settings::load_font_sizes,
            commands::settings::save_font_sizes,
            commands::custom_commands::list_custom_commands,
            commands::custom_commands::agent_command_presets,
            commands::custom_commands::save_custom_command,
            commands::custom_commands::delete_custom_command,
            commands::terminal::open_in_terminal,
            commands::terminal::register_terminal_session,
            commands::terminal::find_session_terminal,
            commands::terminal::focus_session_terminal,
            commands::terminal::cleanup_dead_sessions,
            commands::projects::init_project,
            commands::terminal::run_in_terminal,
            commands::projects::load_project_settings,
            commands::projects::load_project_settings_local,
            commands::projects::save_project_settings,
            commands::projects::save_project_settings_local,
            commands::projects::load_claude_md,
            commands::projects::load_project_metas,
            commands::projects::save_project_meta,
            commands::projects::get_level1_dir_cmd,
            commands::projects::get_mergeable_projects,
            commands::projects::merge_projects_logical,
            commands::projects::split_project,
            commands::projects::get_project_merges,
            commands::projects::get_merged_secondaries,
            commands::presets::list_config_templates,
            commands::presets::list_presets,
            commands::presets::save_preset,
            commands::presets::delete_preset,
            commands::presets::apply_preset,
            commands::settings::get_app_dir,
            commands::agents::agent_list_statuses,
            commands::agents::agent_refresh_health,
            commands::agents::get_agent_tool_mode,
            commands::agents::set_agent_tool_mode,
            commands::agents::get_agent_permission_mode,
            commands::agents::set_agent_permission_mode,
            commands::env_check::check_prerequisite,
            commands::agent_install::install_agent_command,
            commands::agent_install::install_command_needs_elevation,
            commands::env_check::check_environment,
            commands::agents::check_mcp_adapter,
            commands::agents::install_mcp_adapter,
            commands::agents::update_mcp_adapter,
            commands::agents::check_transport_bridge,
            commands::agents::install_transport_bridge,
            commands::agents::agent_official_auth,
            commands::update::check_available_updates,
            commands::update::check_for_update,
            commands::update::download_update,
            os_adapter::cli_link::check_cli_symlink,
            os_adapter::cli_link::install_cli_symlink,
            commands::update::install_update,
            chat::send_message,
            chat::abort_chat,
            chat::steer_chat,
            chat::set_agent_thinking_level,
            chat::compact_agent_session,
            chat::fork_agent_session,
            chat::get_agent_auto_compaction,
            chat::set_agent_auto_compaction,
            chat::resolve_chat_permission,
            chat::respond_chat_interaction,
            image::save_session_files,
            image::read_image_as_data_url,
            image::read_file_as_base64,
            image::get_clipboard_file_paths,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_create_graph,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_get_graph,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_get_latest_graph_for_project,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_list_graphs_for_project,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_list_node_session_ids,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_list_node_sessions,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_list_attempt_dispatches,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_delete_graph,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_get_task_conversation,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_submit_task_interaction,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_submit_task_message,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_get_revision,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_apply_commands,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_validate_commands,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_generate_proposal,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_steer_planner,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_stop_planner_turn,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_start_run,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_propose_run_revision,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_apply_run_revision,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_list_runs,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_get_node_runs,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_get_attempt,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_get_run_projection,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_pause_run,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_resume_run,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_cancel_run,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_pending_approvals,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_resolve_approval,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_run_events_after,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_list_artifacts,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_get_artifact,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_get_diff,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_list_revisions,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_checkout_draft_revision,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_choose_recovery,
            #[cfg(feature = "orchestrator")]
            commands::orchestrator::orchestrator_attach_repair,
            commands::task::task_launch_list_sessions,
            commands::task::task_launch_mark_session,
            commands::task::task_requirement_finalize,
            commands::task::task_launch_start_run,
            commands::task::task_launch_attach_graph,
            commands::task::task_launch_sync_run_status,
            commands::task::task_launch_get_instance,
            commands::task::task_planning_instruction,
            commands::task::task_launch_create_from_existing_graph,
            commands::task::task_launch_rename_task,
            commands::task::task_launch_delete_task,
            commands::task::conductor_sync_phase,
            commands::task::conductor_load_task_state,
            commands::models::test_model,
            commands::models::test_llm_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
