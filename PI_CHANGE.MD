# PI_CHANGE.MD

本文档管理 `third_party/pi` 的 fork 仓库规则与改动记录。
---

# 第一部分：通用管理规则

## 1.1 核心指导原则（修改底线）

> **尽量复用原生开源能力，能不改就不改，不得不改再改；能小改动就不大改动，不得不大改才大改。无论什么样的改动，都必须如实、详细地记录到当前的这个文档中。**

## 1.2 仓库关系

```
┌─────────────────────────────────┐
│jishu-hub（本项目）              │
│  submodule: third_party/        │
│          pi                     │
│        │指向自有 fork           │
└──────────────┬──────────────────┘
               │git submodule
               ▼
┌─────────────────────────────────┐
│wang5766171/pi                   │
│（自有 fork 仓库）               │
│分支: release_v0.79.1-5          │
└──────────────┬──────────────────┘
               │fork from
               ▼
┌─────────────────────────────────┐
│Dicklesworthstone/pi             │
│（上游开源仓库）                 │
│tags: v0.78.1, ...               │
└─────────────────────────────────┘
```

**核心流程**：jishu-hub 通过 submodule 引用自有 fork 仓库的特定分支（命名规则为 `release_v<pi版本>-<自研版本>`）；自有 fork 基于上游开源仓库的 Tag 进行同步，并在其上叠加 jishu-hub 所需的改动。

## 1.3 版本管理规则（带有横杠后缀的版本机制）

为了让上游 Pi 版本与我们的自研迭代独立发展、互不干扰，并且完美兼容 NPM 官方的 Semantic Versioning 规范，我们采用 **<Pi版本号>-<自研版本号>** 的统一版本管理逻辑：

- **自研版本号**为横杠后面的纯数字递增。当前第一版的完整版本号为 `0.78.1-1`。
- **顺延与升级规则**：
  - 如果只有自研内容升级，只需更新尾号：`0.78.1-1` -> `0.78.1-2`。
  - 如果合并了上游的更新（如 Pi 升级到了 `0.78.2`），自研尾号保持顺延不变。即：`0.78.1-2` 合并新版 Pi 后，完整版本号自动变为 `0.78.2-2`。
- **展示与发布的格式统一**：
  - **界面展示 (UI)**：展示为 `0.78.1-1`。
  - **代码分支 (Branch)**：命名为 `release_v0.79.1-5`。
  - **NPM 发布包 (package.json)**：使用 `0.78.1-1`（在 NPM 生态中完美支持，属于预发布版本变体机制）。

## 1.4 当前状态

| 项目 | 地址 |
|------|-----|
| 上游仓库 | `https://github.com/Dicklesworthstone/pi` |
| 自有 fork | `https://github.com/wang5766171/pi` |
| 当前维护分支 | `release_v0.79.1-5` |
| `.gitmodules` URL | `https://github.com/wang5766171/pi` |
| `.gitmodules` branch | `release_v0.79.1-5` |

## 1.5 日常源码变动流程

后续涉及 `pi` 源码的任何修改，按以下步骤操作：

1. **在子模块内直接修改代码**：
   ```bash
   cd third_party/pi
   # 确保处于当前对应的 release_vX.X.X-X 分支
   # 修改文件...
   ```

2. **在子模块内提交并推送到 fork 分支**：
   ```bash
   git add -A
   git commit -m "feat: 描述本次改动"
   git push origin release_v0.79.1-5
   ```

3. **回到 jishu-hub 主仓库，提交 submodule 指针更新**：
   ```bash
   cd ../..  # 回到 jishu-hub 根目录
   git add third_party/pi
   git commit -m "chore: update pi submodule"
   ```

## 1.6 上游版本升级流程

当上游开源仓库发布了新版本（例如 `v0.78.2`）时，需更新分支并合并代码：

1. **获取最新的上游 tags 并创建新分支**：
   ```bash
   cd third_party/pi
   git fetch upstream
   # 基于上游的新 tag 创建对应的新分支（保留当前的自研尾号，如 -1）
   git checkout -b release_v0.79.1-5 v0.78.2
   ```

2. **合并旧版本分支中的自有改动（例如定制规则和依赖修复等）**：
   ```bash
   git merge release_v0.79.1-5
   ```
   *注意：如果在合并时产生冲突，请手动解决冲突，保留 Jishu 的定制改动。*

3. **验证通过后推送到远端自有 fork**：
   ```bash
   git push -u origin release_v0.79.1-5
   ```

4. **更新 jishu-hub 仓库的子模块指向**：
   - 记得同时更新 `.gitmodules` 文件里的 `branch` 字段为新的 `release_v0.79.1-5`。
   ```bash
   cd ../..
   git add third_party/pi .gitmodules
   git commit -m "chore: upgrade pi submodule to v0.79.1-3"
   ```

---

# 第二部分：改动记录

## 第 6 版 (自研尾号 -6)

### 2026-06-11 | 统一 Full/Lite 构建流水线：build-bundle 输出运行时依赖清单（runtime-deps.json）

**根因与背景**：Full（主仓 `pack-pi.mjs`）与 Lite（主仓 `publish-pi.mjs`）历史上是两套独立脚本，各自维护运行时依赖集合。本仓库的 `build-bundle.mjs` 内部其实已计算出 esbuild 需要 externalize 的依赖，但结果从未导出，导致 publish-pi.mjs 不得不在主仓**重新推导**一份（不完整），pack-pi.mjs 则靠 workspace 全量安装**掩盖**了缺失。三方各自为政，漂移使 Lite 连环翻车（缺 provider SDK → `ERR_MODULE_NOT_FOUND`；双 shebang → Node `SyntaxError`）。本次把 build-bundle 计算出的依赖集落盘为清单，作为 Full/Lite 唯一共同的依赖真相。

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| `packages/coding-agent/build-bundle.mjs` | esbuild 构建后**新增输出 `dist/runtime-deps.json`**，记录所有被 externalize 的非 `@earendil-works` 运行时依赖（名称→版本；同一依赖在多包出现时取最高 semver，与 npm 解析一致）。esbuild 的 `external` 列表改为由该清单的键派生，保证“打包时 external 的”与“清单声明的”永远一致。 |

**消费该清单的主仓配套改动（跨仓引用，详见主仓 `PACKAGING.md` §4）**：

- `scripts/lib/pi-common.mjs`（新增）：共享 `fixShebang()`（消除双 shebang）与 `readRuntimeDeps()`（读取清单），Full/Lite 共用同一实现。
- `scripts/pack-pi.mjs`（Full）：打包末尾**断言**清单中每个依赖都物理存在于 `pi-bundle/node_modules`，缺失即构建失败、大声报错——取代过去被 workspace 安静掩盖的行为。
- `scripts/publish-pi.mjs`（Lite）：把清单中的依赖**声明**进发布的 `package.json` 的 `dependencies`，由用户 `npm install` 时拉取——取代主仓内重新推导依赖集的旧逻辑。

**验证（2026-06-11，端到端）**：清单含 25 个运行时依赖，覆盖全部 provider SDK（`openai`、`@anthropic-ai/sdk`、`@google/genai`、`@mistralai/mistralai`、`@aws-sdk/client-bedrock-runtime`、`@smithy/node-http-handler` 等）。Full 断言通过（“All 25 runtime dependencies present”），Lite 暂存的 `package.json` 0 缺失，打包产物 `cli.js --version/--help` 均正常。Full/Lite 现共享同一份 esbuild 产物、同一份清单、同一 shebang 处理，结构上不再可能漂移。

## 第 3 版 (自研尾号 -3)

### 2026-06-10 | 修复内部依赖锁定错误与硬编码版本显示

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| 全局版本同步 | 由于发布 `-2` 版本时遗漏了根目录 `package.json` 的版本更新，导致 npm 别名发布脚本将内部依赖错误地指回了旧版，导致实际执行包损坏。此版本利用新的 `upgrade-version.mjs` 脚本实现了跨全仓库（包括 Rust 后端的 `PI_AGENT_VERSION`、所有子包以及脱机资源包）的 100% 同步升级至 `0.79.1-3`。 |

## 第 2 版 (自研尾号 -2)

### 2026-06-10 | 同步上游开源库版本 v0.79.1

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| 全局 | 同步上游 `v0.79.1` 最新代码，顺延保持 Jishu Hub 的自研特例逻辑（如移除 husky 依赖、去除 generate-models 构建卡点、以及将全局 `pi` CLI 命令重命名为 `jishu`）。 |
| 版本号 | 将各个内部包的 version 从 `0.78.1-2` 升级至 `0.79.1-2`。 |

### 2026-06-09 | NPM Alias 无侵入式发布架构升级

### 改动总览

| 模块 | 改动说明 |
|------|---------|
| 打包发布机制 | **重大架构升级**：彻底废弃了在源码层面通过 Regex 批量替换 `@earendil-works` 为 `@jishu-hub` 的方案。因为这种方式破坏了与上游的同步兼容性。**新方案采用了 NPM 官方的 Alias（别名映射）机制**，保证本地所有的 TypeScript 源码 100% 保持上游原样（0 冲突），仅在 `scripts/publish-pi.mjs` 发布时刻，在临时目录的 `package.json` 中配置 NPM 原生别名。此版本（0.78.1-2）是首个完全无侵入、源码级 100% 兼容上游开源库发布的纯净版本！ |
| `packages/ai` | 移除了 `package.json` 中 `build` 阶段绑定的 `generate-models` 脚本。因为该脚本依赖海外网络获取最新大模型 API 数据，网络超时会导致编译所需的类型文件残缺（如缺少 nvidia 等 provider），从而直接导致后续的 NPM Publish 彻底失败。现恢复使用 git 历史中完好的模型结构文件以保证持续集成的稳定性。 |

## 第 1 版 (自研尾号 -1)

### 2026-06-08 | 原生 Node.js 版本兼容性适配

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
