# ADR 0001: pi-agent-rust 作为灵感来源

**状态**: 已接受
**日期**: 2026-06-01
**影响范围**: CLI、Agent Plugin、编排层、LLM 抽象层

## 背景

jishu-hub v0.6.0 需要设计 CLI、自有 agent（jishu-self）、编排基础设施、LLM 模型抽象层和 ACP 服务端。
pi-agent-rust 项目在这些领域有成熟的架构实践（AgentPlugin trait、LlmProvider trait、Orchestrator 核心思想），
是公开可参考的设计模式来源。

## 决策

参考 pi-agent-rust 的以下架构模式：

- **AgentPlugin trait** — 插件化的智能体抽象，统一健康探测、命令构建、事件归一化
- **三种执行模式** — 交互式/打印/RPC，对应 CLI 的不同使用场景
- **行分隔 JSON RPC** — daemon 通信协议的选择
- **HEAD/TAIL 截断** — 长输出的人类可读展示
- **配置优先级链** — CLI flag > 环境变量 > 项目设置 > 全局设置 > 默认
- **doctor 诊断命令** — 平台健康检查模式

但**不引入** pi-agent-rust 任何源码或依赖。所有实现从零开始，适配 jishu-hub 现有的 Tauri + GUI 体系。

## 理由

1. pi-agent-rust 提供了经过验证的架构模式，减少了设计风险
2. License 隔离要求避免直接使用代码
3. jishu-hub 有独特的 GUI 集成需求和 Tauri 生态约束
4. 独立实现确保长期维护自由度

## 明确排除

- asupersync 运行时
- rich_rust 终端 UI
- 10+ 原生 LLM provider 模块（v0.6.0 仅 openai + anthropic）
- OAuth/凭证管理
- 群体操作（swarm）
- 嵌入式 QuickJS 运行时

## 后果

- **正面**: 借鉴成熟的架构思想，加速开发
- **负面**: 需要独立实现和维护，短期内工作量较大
- **缓解**: 完整的测试覆盖和设计文档

## PR Review Checklist

每个 CLI 相关的 PR 必须确认：
- [ ] 未引入 pi_agent_rust 源码或依赖
- [ ] src-tauri/src/ 中无 `pi_agent_rust`、`asupersync`、`rich_rust` 字符串（文档引用除外）
- [ ] `tests/license_isolation.rs` 通过
