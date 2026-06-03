---
id: openspec
name: OpenSpec
description: 以规格为先定义变更，再完成实现和一致性验证。
---

# OpenSpec Task Planning

OpenSpec 模版强调先写规格，再映射变更、实现，并按规格验收。

<!-- jishu-task-plan
{
  "roles": [
    {
      "role_id": "spec_author",
      "role_name": "规格作者",
      "purpose": "编写能力意图、需求和验收标准",
      "collaborate_with": ["change_designer", "spec_validator"],
      "deliverables": ["规格说明", "验收标准"],
      "responsibilities": ["区分当前行为和目标行为", "保证验收标准可测试"],
      "acceptance": ["规格清晰描述请求变更", "验收标准可测试"],
      "can_edit_files": false,
      "can_run_commands": false,
      "can_receive_rework": true
    },
    {
      "role_id": "change_designer",
      "role_name": "变更设计者",
      "purpose": "将规格需求映射到受影响模块和接口",
      "collaborate_with": ["spec_author", "implementation_owner"],
      "deliverables": ["影响面分析", "实现路径"],
      "responsibilities": ["定义最小实现路径", "标注规格到代码的映射关系"],
      "acceptance": ["受影响面已识别", "实现路径符合规格"],
      "can_edit_files": false,
      "can_run_commands": false,
      "can_receive_rework": true
    },
    {
      "role_id": "implementation_owner",
      "role_name": "实现负责人",
      "purpose": "实现由规格支撑的变更",
      "collaborate_with": ["change_designer", "spec_validator"],
      "deliverables": ["代码变更", "规格追踪说明"],
      "responsibilities": ["保持需求到代码变更的可追踪性", "处理规格验证反馈"],
      "acceptance": ["实现满足规格要求", "追踪关系可检查"],
      "can_edit_files": true,
      "can_run_commands": true,
      "can_receive_rework": true
    },
    {
      "role_id": "spec_validator",
      "role_name": "规格验证者",
      "purpose": "根据书面规格验证实现",
      "collaborate_with": ["spec_author", "implementation_owner"],
      "deliverables": ["一致性报告", "返工清单"],
      "responsibilities": ["逐条检查验收标准", "将一致性缺口反馈给责任角色"],
      "acceptance": ["每条验收标准都已检查", "缺口已分配责任人"],
      "can_edit_files": false,
      "can_run_commands": true,
      "can_receive_rework": false
    }
  ]
}
-->
