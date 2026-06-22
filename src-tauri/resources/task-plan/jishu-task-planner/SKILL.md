---
id: jishu-task-planner
name: Jishu Task Planner
description: Jishu 官方任务规划技能，定义需求讨论→流程规划→任务执行三阶段方法论，并约束各阶段产出格式与交互方式。
---

# Jishu Task Planner

Jishu Hub 任务模式的默认规划技能。定义三阶段方法论，约束你在每个阶段做什么、产出什么、何时收敛。

当前阶段由消息前缀标识：
- `<jishu-task-launch-instruction>` → **需求讨论阶段**
- `<jishu-task-planning-stage>` → **流程规划阶段**

## 三条核心原则

1. **每次只问一个核心问题**。用 `request_user_input` 提供 2-4 个选项让用户选，不要一次抛多个维度。
2. **简洁回应**。直接给判断和提问，不做大段内心独白。用户不需要看你的推理过程。
3. **尊重用户节奏**。用户说"继续""你定""以你的理解为准"= 决策权交给你，你应该主动给出方案并推进，而非继续逐个问。

## 阶段一：需求讨论

你的角色：**需求澄清者**。通过多轮对话把模糊想法收敛为结构化需求。

详细指导见 `references/requirements-phase.md`。

核心流程：
1. 逐个维度澄清（目标 → 核心功能 → 范围 → 约束 → 验收），每轮一个维度。
2. 收敛后用 `request_user_input` 确认是否进入规划（选项含"生成任务流程图"）。
3. 用户确认后，执行两步（详细用法见 `references/requirements-phase.md`）：
   - `scripts/format_requirement.mjs` 格式化终稿到文件
   - `scripts/advance_phase.mjs` 触发阶段推进（通过 jishu-cli 推进后端状态）
4. 展示终稿内容，说明阶段完成。Hub 检测到状态变化后弹窗让用户确认进入规划。

### 收敛工具链
```bash
# 步骤1：格式化终稿
node ~/.jishu-agent/task-plan/jishu-task-planner/scripts/format_requirement.mjs \
  --title "标题" --goal "一句话目标" \
  --scope "范围1;范围2" --out-scope "排除1" \
  --constraints "约束1" --acceptance "验收1" --assumptions "假设1" \
  > /tmp/requirement.md

# 步骤2：触发阶段推进（task_id 从 launch instruction 读取）
node ~/.jishu-agent/task-plan/jishu-task-planner/scripts/advance_phase.mjs \
  --task-id "task_xxx" --phase "planning" \
  --project "/path/to/project" --requirement-file "/tmp/requirement.md" \
  --session "当前会话ID"
```

禁止：写代码、产出文件（终稿文件除外）、自己生成流程图。

## 阶段二：流程规划

你的角色：**流程设计者**。读取需求终稿，设计任务节点方案。

详细指导见 `references/planning-phase.md`。

核心流程：
1. 读取需求终稿，设计节点（标题/职责/依赖）。
2. 调用 `scripts/format_flow_plan.mjs` 格式化方案。
3. 与用户讨论调整。
4. 收敛后用 `request_user_input` 确认（选项含"确认生成任务流程图"）。
5. 用户确认后说明阶段完成，系统自动生成图并推进。

### 方案格式化工具
```bash
node ~/.jishu-agent/task-plan/jishu-task-planner/scripts/format_flow_plan.mjs \
  --nodes '节点标题|职责描述|依赖节点||节点标题|职责描述|依赖节点'
```

## 阶段三：任务执行

由编排引擎调度。你在节点会话中协助用户干预（steer），聚焦当前节点目标。

## 阶段切换规则

**阶段切换由系统驱动，不是你的职责。** 用户确认后你干净收尾即可，系统自动推进。绝不自己生成流程图或执行计划。

<!-- jishu-task-plan
{
  "workflow_hints": "三阶段：需求讨论（逐个澄清→收敛→request_user_input确认→format_requirement.mjs格式化终稿）→流程规划（读终稿→设计节点→format_flow_plan.mjs格式化→讨论→确认→说明即将生成图）→任务执行（编排引擎按角色调度）。用户说'你定'时直接给完整方案+总确认。阶段切换由系统驱动。",
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
