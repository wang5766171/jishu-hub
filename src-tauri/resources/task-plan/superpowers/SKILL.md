---
id: superpowers
name: Superpowers
description: 按照头脑风暴、计划、实现、验证的节奏推进，并用证据确认完成。
---

# Superpowers Task Planning

Superpowers 模版强调先理解、再计划、再实现、最后用证据验证。

<!-- jishu-task-plan
{
  "roles": [
    {
      "role_id": "brainstormer",
      "role_name": "探索者",
      "purpose": "在实现前探索意图、约束和可选方案",
      "collaborate_with": ["planner", "implementer"],
      "deliverables": ["意图澄清", "方案选项", "关键决策"],
      "responsibilities": ["暴露需要在计划中固定的关键决策", "避免过早进入实现"],
      "acceptance": ["选定方案体现用户意图", "未决事项清晰可见"],
      "can_edit_files": false,
      "can_run_commands": false,
      "can_receive_rework": true
    },
    {
      "role_id": "planner",
      "role_name": "计划者",
      "purpose": "将选定方案转化为有顺序的实施步骤",
      "collaborate_with": ["brainstormer", "implementer", "verifier"],
      "deliverables": ["实施计划", "检查点", "验证命令"],
      "responsibilities": ["定义变更范围和执行顺序", "明确每一步的验收方式"],
      "acceptance": ["计划顺序和范围清晰", "验证方式具体"],
      "can_edit_files": false,
      "can_run_commands": false,
      "can_receive_rework": true
    },
    {
      "role_id": "implementer",
      "role_name": "实施者",
      "purpose": "按计划完成范围内变更",
      "collaborate_with": ["planner", "verifier"],
      "deliverables": ["代码变更", "实现说明"],
      "responsibilities": ["保持实现符合既有代码风格", "处理验证角色反馈的返工"],
      "acceptance": ["计划中的变更已完成", "没有引入无关变更"],
      "can_edit_files": true,
      "can_run_commands": true,
      "can_receive_rework": true
    },
    {
      "role_id": "verifier",
      "role_name": "验证者",
      "purpose": "运行约定验证并系统性检查失败",
      "collaborate_with": ["planner", "implementer"],
      "deliverables": ["验证结果", "失败分析", "完成证据"],
      "responsibilities": ["只在有证据时确认完成", "把失败归因给对应角色"],
      "acceptance": ["验证命令通过或阻塞点已记录", "完成结论附带证据"],
      "can_edit_files": false,
      "can_run_commands": true,
      "can_receive_rework": false
    }
  ]
}
-->
