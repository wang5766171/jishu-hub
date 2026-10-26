/// CLI-IPC parity test: verifies that CLI subcommand files exist and contain
/// the expected handler functions for the current public CLI surface.
#[test]
fn cli_command_files_exist() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let commands_dir = manifest.join("src").join("cli").join("commands");

    let expected = [
        ("agent/chat.rs", "Chat command handler"),
        ("agent/run.rs", "Run command handler"),
        ("agent/model.rs", "Model command handler"),
        ("orchestrator/agents.rs", "Agents command handler"),
        ("orchestrator/plan.rs", "Plan command handler"),
        ("orchestrator/task.rs", "Task command handler"),
        ("orchestrator/event.rs", "Event command handler"),
        ("orchestrator/evolve.rs", "Evolve command handler"),
        ("orchestrator/daemon.rs", "Daemon command handler"),
        ("doctor.rs", "Doctor command handler"),
        ("acp.rs", "ACP command handler"),
        // v0.8.1 需求4/8/10（M0-b 接线回归锚点——孤儿模块事故复发即挂）。
        ("plugins.rs", "Plugins command handler"),
        ("task_artifact.rs", "Task-artifact command handler"),
        ("memory.rs", "Memory command handler"),
        // v0.9.0 需求1（mcp，补锁）/ 需求20（skill）。
        ("mcp.rs", "MCP command handler"),
        ("skill.rs", "Skill command handler"),
    ];

    for (file, _desc) in &expected {
        let path = commands_dir.join(file);
        assert!(path.exists(), "CLI command file missing: {file}");
    }
}

#[test]
fn cli_args_define_all_public_subcommands() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let args_path = manifest.join("src").join("cli").join("args.rs");
    let content = std::fs::read_to_string(&args_path).unwrap();

    let expected_variants = [
        "Agents", "Chat", "Doctor", "Plan", "Task", "Event", "Run", "Model", "Daemon", "Evolve",
        "Acp", "Plugins", "TaskArtifact", "Memory", "Mcp", "Skill",
    ];

    for variant in &expected_variants {
        assert!(
            content.contains(variant),
            "Commands enum missing variant: {variant}"
        );
    }

    assert!(
        !content.contains("AgentBridge"),
        "temporary AgentBridge must not be part of the public CLI surface"
    );
}
