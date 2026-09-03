# v0.8.1 代码恢复工具（2026-08-29）

背景：git 仓库损坏修复过程中 `git reset --hard` 误清了工作区，v0.8.1 全部
新增文件丢失。本目录是当时的恢复工具与产物（`snapshot/` 未入库，仅脚本与
报告提交）。

恢复来源：ZCode 会话记录 `~/.zcode/cli/agents/sess_*/agent_*/transcript.jsonl`
中 subagent 的 Read 快照（审查 subagent 在 8/29 读过全部核心文件的最终态）。

| 阶段 | 脚本 | 作用 |
|---|---|---|
| 1 | phase1-subagent-reads.mjs | 从审查 subagent transcript 提取 Read 快照 |
| 2 | phase2-rollout-ops.mjs | 从主会话 rollout 提取 Write/Edit 调用（context 压缩致不可用） |
| 3 | phase3-all-transcripts.mjs | 扫描全部 44 个 subagent transcript（181 个文件快照） |
| 4 | phase4-apply.mjs | 快照落盘（行数防降级跳过片段） |
| 5 | phase5-rollback.mjs | 止损：回滚中段快照对既有文件的覆盖，只留 8/29 最终态 |
| 6 | phase6-fix-pollution.mjs | 清除 cat -n 双层行号残留 |
| 7 | phase7-role-split.py | adapter 角色方法搬迁（ConfigAdapter 胖接口 → 角色 impl） |

手工重建（快照缺失，按 docs/v0.8.1 设计文档重写）：
- agent/config_roles.rs、policy_store.rs、manifest/agent.rs、manifest/store.rs
- chat.rs compose_tool_message、agent_runtime.rs hub_context_envs
- lib.rs AppState.tool_plugins 与命令注册、chat-input.tsx 工具 token 集成

验证：cargo test --lib 511 全绿；vitest 230 全绿；tauri build 产出
`Jishu Hub_0.8.1_x64-setup.exe`。

`snapshot/` 与 `snapshot-manifest.json`、`apply-report.json`、`ops.json`
不入库（体积 + 中间产物）；需要时重跑脚本即可再生成。
