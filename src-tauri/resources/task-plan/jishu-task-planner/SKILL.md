---
id: jishu-task-planner
name: Jishu Task Planner
description: Jishu 官方任务规划 skill，按需求、架构、开发、测试、审计的常规工程链路生成标准角色职责。
---

# Jishu Task Planner

把 HUB 中的任务描述转换为 jishu-agent 可执行的角色分工。所有角色职责必须使用统一语义：

- `角色目标`：该角色为什么存在。
- `协作对象`：该角色需要读取、审核或反馈哪些角色的产出。
- `交付物`：该角色必须留下什么结果。
- `执行规则`：该角色推进任务时必须遵守的要求。
- `返工规则`：发现问题时必须标注责任角色、原因和建议动作，交给 jishu agent 形成返工任务。

<!-- jishu-task-plan
{
  "roles": [
    {
      "role_id": "requirements_owner",
      "role_name": "需求负责人",
      "purpose": "澄清任务目标、边界、优先级和验收口径",
      "collaborate_with": ["architect", "auditor"],
      "deliverables": ["需求说明", "验收口径"],
      "responsibilities": ["把模糊需求拆成可执行约束", "确认用户指定的人工分配规则"],
      "acceptance": ["目标、非目标和成功标准明确", "每个角色都能追溯到任务目标"],
      "can_edit_files": false,
      "can_run_commands": false,
      "can_receive_rework": true
    },
    {
      "role_id": "architect",
      "role_name": "架构师",
      "purpose": "完成架构设计、模块边界、依赖关系和技术路径",
      "collaborate_with": ["requirements_owner", "developer", "auditor"],
      "deliverables": ["架构方案", "实现约束", "风险清单"],
      "responsibilities": ["负责指导开发角色的实现方向", "对关键设计风险给出替代方案"],
      "acceptance": ["架构决策明确且风险可追踪", "开发角色能直接按约束实施"],
      "can_edit_files": false,
      "can_run_commands": false,
      "can_receive_rework": true
    },
    {
      "role_id": "developer",
      "role_name": "开发工程师",
      "purpose": "按照架构约束完成代码实现",
      "collaborate_with": ["architect", "tester", "auditor"],
      "deliverables": ["代码变更", "实现说明", "验证记录"],
      "responsibilities": ["负责修复测试和审计反馈中归因到开发的问题", "保持变更范围收敛"],
      "acceptance": ["代码满足任务目标且无无关变更", "本地验证结果可复查"],
      "can_edit_files": true,
      "can_run_commands": true,
      "can_receive_rework": true
    },
    {
      "role_id": "tester",
      "role_name": "测试工程师",
      "purpose": "验证开发交付是否满足需求和关键路径",
      "collaborate_with": ["requirements_owner", "developer", "auditor"],
      "deliverables": ["测试结果", "缺陷列表", "复现步骤"],
      "responsibilities": ["负责把失败用例归因到对应角色", "补充必要的回归检查"],
      "acceptance": ["关键路径已验证，失败具备复现信息", "缺陷已标注责任角色"],
      "can_edit_files": false,
      "can_run_commands": true,
      "can_receive_rework": false
    },
    {
      "role_id": "auditor",
      "role_name": "审计员",
      "purpose": "审核开发角色的代码质量、风险和测试缺口",
      "collaborate_with": ["architect", "developer", "tester"],
      "deliverables": ["审计报告", "返工建议", "剩余风险"],
      "responsibilities": ["负责把审计问题分配给对应角色改进", "检查任务是否满足用户验收口径"],
      "acceptance": ["P0/P1 风险已明确，返工对象清晰", "审计结论可被 jishu agent 转换为后续任务"],
      "can_edit_files": false,
      "can_run_commands": true,
      "can_receive_rework": false
    }
  ]
}
-->
