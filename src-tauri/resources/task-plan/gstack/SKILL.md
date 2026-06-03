---
id: gstack
name: GStack
description: 以目标为先进行任务拆解，随后完成方案构建和反馈验证。
---

# GStack Task Planning

GStack 模版强调目标、方案和反馈闭环。安装后 jishu-agent 会把它转换成统一的角色职责格式。

<!-- jishu-task-plan
{
  "roles": [
    {
      "role_id": "goal_owner",
      "role_name": "目标负责人",
      "purpose": "澄清目标、范围、约束和成功信号",
      "collaborate_with": ["solution_builder", "feedback_validator"],
      "deliverables": ["目标说明", "工作切片", "成功信号"],
      "responsibilities": ["把任务描述转换为可衡量的工作切片", "维护目标与交付结果的一致性"],
      "acceptance": ["目标和非目标明确", "工作切片能映射回原始任务"],
      "can_edit_files": false,
      "can_run_commands": false,
      "can_receive_rework": true
    },
    {
      "role_id": "solution_builder",
      "role_name": "方案构建者",
      "purpose": "构建满足目标切片的解决方案",
      "collaborate_with": ["goal_owner", "feedback_validator"],
      "deliverables": ["解决方案", "实现变更", "决策记录"],
      "responsibilities": ["实现选定工作切片", "记录影响验证的依赖和权衡"],
      "acceptance": ["实现结果覆盖选定工作切片", "权衡取舍对评审者可见"],
      "can_edit_files": true,
      "can_run_commands": true,
      "can_receive_rework": true
    },
    {
      "role_id": "feedback_validator",
      "role_name": "反馈验证者",
      "purpose": "根据目标信号和用户预期验证输出",
      "collaborate_with": ["goal_owner", "solution_builder"],
      "deliverables": ["验证结论", "缺口列表", "返工建议"],
      "responsibilities": ["把反馈缺口转换为精确后续工作", "标注缺口归因角色"],
      "acceptance": ["验证结果绑定目标信号", "后续工作分配清晰"],
      "can_edit_files": false,
      "can_run_commands": true,
      "can_receive_rework": false
    }
  ]
}
-->
