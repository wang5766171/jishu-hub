# Git 提交规范（供智能体执行）

本文件供各 AI 智能体（Claude / OpenCode / Antigravity / Codex 等）在执行 git 提交时遵循。

## 1. 提交信息用中文

所有 commit message 必须使用中文。

## 2. 以当前 agent 名称开头

message 以 `agent名:` 作为前缀，表明本次提交由哪个智能体产生。常见前缀：

| 智能体 | 前缀 |
|--------|------|
| Claude | `claude:` |
| OpenCode | `opencode:` |
| Antigravity | `antigravity:` |
| Codex | `codex:` |

格式：

```
<agent>: <中文描述>
```

若涉及明确的功能模块，可加类型与作用域（与仓库现有习惯一致）：

```
<agent>: <类型>(<模块>): <中文描述>
```

示例：

```
claude: 任务工作台新增任务列表视图
opencode: feat(orchestrator): 新增按项目列出任务图接口
codex: fix(graph-editor): 修复节点选中态丢失问题
```

## 3. 按功能模块或问题分批提交

- **同一问题/功能涉及的多个文件一起提交。**
  例如修复「问题 A」涉及 `a.ts`、`b.ts`、`c.ts` 三个文件，则这三个文件作为一次提交，message 描述该问题。
- **一个文件同时涉及多个问题时，无需精确拆分。**
  该文件跟随其中任意一个问题一起提交即可，不必为了拆分而对单个文件做多次 `add -p`。
- 多个独立、互不相关的问题，应拆成多次提交，不要混在一个 commit 里。

原则：一次提交 = 一个内聚的改动主题。文件跟着主题走，不为追求文件粒度的纯净而过度拆分。

## 4. 不要做的事

- **不要回滚自己不熟悉或归属不明的改动。** 禁止对不明确的改动使用 `git reset --hard`、`git checkout --`、`git restore`、`git revert`、`git stash drop`、`git clean -fd` 等会丢弃工作区内容的命令。仓库里可能存在其他智能体或用户正在进行的本地改动（典型如 `.gitignore`、`CLAUDE.md` 等配置文件），凡是不清楚来源与意图的改动一律保留；遇到冲突先向用户确认，绝不擅自"清理"工作区——一次错误的回滚就会把别人未提交的工作抹掉。
- **不要提交已被 `.gitignore` 忽略的内容。** 提交前使用 `git check-ignore` 或 `git status --ignored` 核对目标；禁止使用 `git add -f` 绕过忽略规则。只有用户明确要求提交某个被忽略的文件时，才可对该指定文件例外处理。
- 不要使用英文 message。
- 不要省略 agent 前缀。
- 不要把不相关的多个问题塞进同一个 commit。
- 除非用户明确要求，不要自动 push（本仓库仅发版时向 master 推送）。
