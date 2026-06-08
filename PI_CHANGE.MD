# PI_CHANGE.MD

本文档管理 `third_party/pi` 的 fork 仓库规则与改动记录。
---

# 第一部分：通用管理规则

## 1.1 核心指导原则（修改底线）

> **尽量复用原生开源能力，能不改就不改，不得不改再改；能小改动就不大改动，不得不大改才大改。无论什么样的改动，都必须如实、详细地记录到当前的这个文档中。**

## 1.2 仓库关系

```
┌─────────────────────────────────┐
│ jishu-hub（本项目）             │
│ submodule: third_party/         │
│           pi                    │
│         │指向自有 fork         │
└──────────────┬──────────────────┘
               │git submodule
               ▼
┌─────────────────────────────────┐
│ wang5766171/pi                 │
│ （自有 fork 仓库）              │
│ 分支: release_v0.78.1_change    │
└──────────────┬──────────────────┘
               │fork from
               ▼
┌─────────────────────────────────┐
│ Dicklesworthstone/pi           │
│ （上游开源仓库）                 │
│ tags: v0.78.1, ...             │
└─────────────────────────────────┘
```

**核心流程**：jishu-hub 通过 submodule 引用自有 fork 仓库的特定分支（命名规则为 `release_<tag版本>_change`）；自有 fork 基于上游开源仓库的 Tag 进行同步，并在其上叠加 jishu-hub 所需的改动。

## 1.3 当前状态
| 项目 | 值 |
|------|-----|
| 上游仓库 | `https://github.com/Dicklesworthstone/pi` |
| 自有 fork | `https://github.com/wang5766171/pi` |
| 当前维护分支 | `release_v0.78.1_change` |
| `.gitmodules` URL | `https://github.com/wang5766171/pi` |
| `.gitmodules` branch | `release_v0.78.1_change` |

## 1.4 日常源码变动流程

后续涉及 `pi` 源码的任何修改，按以下步骤操作：

1. **在子模块内直接修改代码**：
   ```bash
   cd third_party/pi
   # 确保处于当前对应的 release_vX.X.X_change 分支
   # 修改文件...
   ```

2. **在子模块内提交并推送到 fork 分支**：
   ```bash
   git add -A
   git commit -m "feat: 描述本次改动"
   git push origin release_v0.78.1_change
   ```

3. **回到 jishu-hub 主仓库，提交 submodule 指针更新**：
   ```bash
   cd ../..  # 回到 jishu-hub 根目录
   git add third_party/pi
   git commit -m "chore: update pi submodule"
   ```

## 1.5 上游版本升级流程

当上游开源仓库发布了新版本（例如 `v0.78.2`）时，需更新分支并合并代码：

1. **获取最新的上游 tags 并创建新分支**：
   ```bash
   cd third_party/pi
   git fetch upstream
   # 基于上游的新 tag 创建对应的新分支
   git checkout -b release_v0.78.2_change v0.78.2
   ```

2. **合并旧版本分支中的自有改动（例如定制规则和依赖修复等）**：
   ```bash
   git merge release_v0.78.1_change
   ```
   *注意：如果在合并时产生冲突，请手动解决冲突，保留 Jishu 的定制改动。*

3. **验证通过后推送到远端自有 fork**：
   ```bash
   git push -u origin release_v0.78.2_change
   ```

4. **更新 jishu-hub 仓库的子模块指向**：
   - 记得同时更新 `.gitmodules` 文件里的 `branch` 字段为新的 `release_v0.78.2_change`。
   ```bash
   cd ../..
   git add third_party/pi .gitmodules
   git commit -m "chore: upgrade pi submodule to v0.78.2"
   ```

---

# 第二部分：改动记录

## 2026-06-08 | 原生 Node.js 版本兼容性适配

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| `package.json` | 移除了强制要求的 `husky` 钩子报错逻辑。将 `"prepare": "husky"` 替换为忽略错误的方式，解决在用户机器部署时由于缺少 husky 依赖导致整个 npm 安装失败的问题。 |

## 2026-06-07 | 迁移至原生 Node.js 版本的 Pi

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| Jishu Agent 集成方式 | 移除 `pi_agent_rust`，改为通过 `git submodule` 引入原生的 `wang5766171/pi@0.78.1` |
| 运行方式 | 放弃构建内嵌的 `pi.exe`，转为依赖用户机器环境中的 Node.js 运行捆绑下发的 Javascript 代码 |

**上游基线**：`v0.78.1` tag

**改动背景**：
之前由于 `pi_agent_rust` 是参考原生 Pi 的 Rust 版本移植，并没有经过详细的调研，导致其能力（如 MCP 服务扩展支持）与原生 Node 的 Pi 存在差异。因此决定切换回原生项目以确保后续代码技术匹配及各项能力的完整支持。
