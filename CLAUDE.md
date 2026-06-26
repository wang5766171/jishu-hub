## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## 项目关键文档（必读）

下列文档已纳入仓库版本管理，开发前按需查阅：

- **`DEVELOP_READ.MD`** —— 开发最高层级工程指导：架构分层与约束。新需求、重构、缺陷修复、架构升级前必须先对照本文档；当代码、历史文档或临时方案与之冲突时，以本文档为准，并同步修正文档或提交架构变更说明。
- **`PI_CHANGE.MD`** —— `third_party/pi` fork 的管理规则与改动记录。修改 pi 前必读；任何改动都必须如实、详细地记录到本文档。
- **`PACKAGING.md`** —— 打包与发布指南：Windows Full/Lite 本地构建、macOS 云端自动化打包。

## Git 提交规范

执行 git 提交前，必须遵循 `agent-commit-guide.md`（本地文件，未跟踪）。要点：
- message 用中文；
- 以当前 agent 名称开头作前缀，如 `claude:`；
- 按问题/功能分批提交；一个文件涉及多个问题时跟随任一问题即可，无需拆分单文件。
