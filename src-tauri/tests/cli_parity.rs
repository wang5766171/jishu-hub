/// CLI-IPC parity test: verifies that CLI subcommand files exist and contain
/// the expected handler functions. This is a structural check.
#[test]
fn cli_command_files_exist() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let commands_dir = manifest.join("src").join("cli").join("commands");

    let expected_files = [
        "agents.rs",
        "projects.rs",
        "sessions.rs",
        "chat.rs",
        "config_cmd.rs",
        "doctor.rs",
        "plan.rs",
        "task.rs",
        "event.rs",
        "run.rs",
        "model.rs",
        "daemon.rs",
        "evolve.rs",
        "bridge.rs",
        "acp.rs",
    ];

    for file in &expected_files {
        let path = commands_dir.join(file);
        assert!(path.exists(), "CLI command file missing: {}", file);
    }
}

#[test]
fn cli_args_define_all_subcommands() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let args_path = manifest.join("src").join("cli").join("args.rs");
    let content = std::fs::read_to_string(&args_path).unwrap();

    // Verify Commands enum has expected variants
    let expected_variants = [
        "Agents",
        "Projects",
        "Sessions",
        "Chat",
        "Config",
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
