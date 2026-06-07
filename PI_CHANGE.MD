# PI_CHANGE.MD

本文档管理 `third_party/pi` 的 fork 仓库规则与改动记录。

---

# 第一部分：通用管理规则

## 1.1 仓库关系

```
┌─────────────────────────────────┐
│  jishu-hub（本项目）              │
│  submodule: third_party/         │
│            pi                    │
│          ↓ 指向自有 fork         │
└──────────────┬──────────────────┘
               │ git submodule
               ▼
┌─────────────────────────────────┐
│  wang5766171/pi                 │
│  （自有 fork 仓库）               │
│  分支: main / tag: v0.78.1       │
└──────────────┬──────────────────┘
               │ fork from
               ▼
┌─────────────────────────────────┐
│  Dicklesworthstone/pi           │
│  （上游开源仓库）                 │
│  tags: v0.78.1, ...             │
└─────────────────────────────────┘
```

**核心流程**：jishu-hub 通过 submodule 引用自有 fork 仓库的特定 tag 或分支；自有 fork 基于上游开源仓库进行同步，并在其上叠加 jishu-hub 所需的可能改动。

## 1.2 当前状态

| 项目 | 值 |
|------|-----|
| 上游仓库 | `https://github.com/Dicklesworthstone/pi` |
| 自有 fork | `https://github.com/wang5766171/pi` |
| 当前维护分支/Tag | `v0.78.1` |
| `.gitmodules` URL | `https://github.com/wang5766171/pi` |
| `.gitmodules` branch | `main` |

## 1.3 日常源码变动流程

后续涉及 `pi` 源码的任何修改，按以下步骤操作：

1. **在子模块内直接修改代码**：
   ```bash
   cd third_party/pi
   # 修改文件...
   ```

2. **在子模块内提交并推送到 fork 分支**：
   ```bash
   git add -A
   git commit -m "feat: 描述本次改动"
   git push origin main
   ```

3. **回到 jishu-hub 主仓库，提交 submodule 指针更新**：
   ```bash
   cd ../..  # 回到 jishu-hub 根目录
   git add third_party/pi
   git commit -m "chore: update pi submodule"
   ```

## 1.4 上游版本升级流程

当上游发布新版本时：

1. 在自有 fork 仓库中 fetch 上游分支/tags：
   ```bash
   git fetch upstream
   git merge upstream/main  # 或者 fetch tags 后合并
   ```

2. 解决可能存在的冲突，保留 Jishu 需要的定制改动。

3. 验证通过后推送：
   ```bash
   git push origin main
   ```

4. 更新 jishu-hub submodule 指向新的提交或分支：
   ```bash
   # 主仓库更新 submodule 指针
   git add third_party/pi
   git commit -m "chore: upgrade pi submodule"
   ```

---

# 第二部分：改动记录

## 2026-06-07 | 迁移至原生 Node.js 版本的 Pi

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| Jishu Agent 集成方式 | 移除 `pi_agent_rust`，改为通过 `git submodule` 引入原生的 `wang5766171/pi@0.78.1` |
| 运行时 | 放弃构建内嵌的 `pi.exe`，转为依赖用户机器环境中的 Node.js 运行捆绑下发的 Javascript 代码 |
| 安装逻辑 | 改进了 `Jishu Hub` 的环境检测界面，通过后台执行 `npm install --production` 自动在本地部署 Jishu Agent 及其依赖 |
| `pi_runtime.rs` | 调整运行时探测逻辑，使其直接启动 `~/.jishu-agent/pi/dist/index.js` 而不是寻找 `.exe` 文件 |
| MCP 服务 | 现已直接依赖原生 Pi 提供的 TypeScript/Node 能力，解决了之前在 Rust 移植版中对 QuickJS 引擎的依赖和功能缺失问题 |

**上游基线**：`v0.78.1` tag

**改动背景**：

之前由于 `pi_agent_rust` 是参考原始 Pi 的 Rust 版本移植，并没有经过详细的调研，导致其能力（如 MCP 服务扩展支持）与原生 Node 版 Pi 存在差异。因此决定切换回原生项目以确保后续代码技术匹配及各项能力的完整支持。
