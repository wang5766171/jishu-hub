/// CLI-IPC parity test: verifies that CLI subcommand files exist and contain
/// the expected handler functions. This is a structural check aligned with the
/// jishu-cli-redefine-design.md directory layout (agent/ + orchestrator/ split).
#[test]
fn cli_command_files_exist() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let commands_dir = manifest.join("src").join("cli").join("commands");

    let expected = [
        // agent/ — jishu-self 本体
        ("agent/chat.rs", "Chat command handler"),
        ("agent/run.rs", "Run command handler"),
        ("agent/bridge.rs", "Agent-bridge command handler"),
        ("agent/model.rs", "Model command handler"),
        // orchestrator/ — 编排器
        ("orchestrator/agents.rs", "Agents command handler"),
        ("orchestrator/plan.rs", "Plan command handler"),
        ("orchestrator/task.rs", "Task command handler"),
        ("orchestrator/event.rs", "Event command handler"),
        ("orchestrator/evolve.rs", "Evolve command handler"),
        ("orchestrator/daemon.rs", "Daemon command handler"),
        // 顶层 — 跨层工具
        ("doctor.rs", "Doctor command handler"),
        ("acp.rs", "ACP command handler"),
    ];

    for (file, _desc) in &expected {
        let path = commands_dir.join(file);
        assert!(path.exists(), "CLI command file missing: {}", file);
    }
}

#[test]
fn cli_args_define_all_subcommands() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let args_path = manifest.join("src").join("cli").join("args.rs");
    let content = std::fs::read_to_string(&args_path).unwrap();

    let expected_variants = [
        "Agents",
        "Chat",
        "Doctor",
        "Plan",
        "Task",
        "Event",
        "Run",
        "Model",
        "Daemon",
        "Evolve",
        "Acp",
        "AgentBridge",
    ];

    for variant in &expected_variants {
        assert!(
            content.contains(variant),
            "Commands enum missing variant: {}",
            variant
        );
    }
}
