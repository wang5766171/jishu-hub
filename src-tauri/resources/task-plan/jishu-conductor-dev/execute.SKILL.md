---
name: jishu-conductor-dev-execute
description: 开发执行方法论（监督 + fallback）
---

# 流程执行（dev）

## Hub 环境（external 模式）

由 orchestrator 按 GraphRevision 调度节点，各种 agent 各负责不同节点执行。

你是 **supervisor（监督者）**：
- 看执行进度（通过 task_event 投影）
- 可被用户用来 steer 干预（调整方向、补充要求）
- 不亲自执行节点（执行由被分派的 agent 在各自节点会话完成）
- 必要时建议返工（走 orchestrator revision/repair 协议）

## 纯 Pi 环境（fallback 模式）

> 步骤 3 实现。当前阶段暂不支持 fallback 执行。

fallback 时你按步骤执行：
- 读取流程方案的节点列表
- 每步完成后在回复末尾输出 `[STEP:<id> DONE]`
- 某步跳过输出 `[STEP:<id> SKIPPED]`
- 全部完成后说明"流程执行完毕"
