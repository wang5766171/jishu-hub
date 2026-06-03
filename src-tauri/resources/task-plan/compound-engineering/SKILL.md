---
id: compound-engineering
name: Compound Engineering
description: 面向并行工程的编排、集成和质量审计流程。
---

# Compound Engineering Task Planning

Compound Engineering 模版强调并行工作包、集成和最终质量审计。

<!-- jishu-task-plan
{
  "roles": [
    {
      "role_id": "orchestrator",
      "role_name": "编排者",
      "purpose": "将任务拆成可并行的工作包并分配归属",
      "collaborate_with": ["parallel_engineer", "integrator", "quality_auditor"],
      "deliverables": ["工作包清单", "依赖关系", "调度状态"],
      "responsibilities": ["监督进度并处理依赖冲突", "维护各角色的返工路由"],
      "acceptance": ["工作包具备负责人和边界", "依赖关系清晰可见"],
      "can_edit_files": false,
      "can_run_commands": false,
      "can_receive_rework": true
    },
    {
      "role_id": "parallel_engineer",
      "role_name": "并行工程师",
      "purpose": "独立交付被分配的工作包",
      "collaborate_with": ["orchestrator", "integrator"],
      "deliverables": ["工作包变更", "集成说明"],
      "responsibilities": ["尽早暴露集成要求", "保证本工作包边界清晰"],
      "acceptance": ["分配的工作包已完成", "已提供集成说明"],
      "can_edit_files": true,
      "can_run_commands": true,
      "can_receive_rework": true
    },
    {
      "role_id": "integrator",
      "role_name": "集成者",
      "purpose": "将并行输出整合为一致结果",
      "collaborate_with": ["parallel_engineer", "quality_auditor"],
      "deliverables": ["集成结果", "冲突处理记录"],
      "responsibilities": ["解决冲突并保留跨角色意图", "把无法解决的冲突升级给编排者"],
      "acceptance": ["集成结果一致", "冲突已解决或升级"],
      "can_edit_files": true,
      "can_run_commands": true,
      "can_receive_rework": true
    },
    {
      "role_id": "quality_auditor",
      "role_name": "质量审计员",
      "purpose": "审计集成结果的正确性、一致性和回归风险",
      "collaborate_with": ["orchestrator", "integrator", "parallel_engineer"],
      "deliverables": ["质量审计报告", "返工建议"],
      "responsibilities": ["将返工路由给对应角色", "检查并行结果是否破坏整体一致性"],
      "acceptance": ["质量风险已记录", "返工分配精确"],
      "can_edit_files": false,
      "can_run_commands": true,
      "can_receive_rework": false
    }
  ]
}
-->
