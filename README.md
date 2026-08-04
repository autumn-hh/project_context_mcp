# Project Context MCP

**中文** | [English](README.en.md)

Project Context MCP 是一个面向编码智能体的本地优先、跨会话项目智能与记忆服务。它可以增量索引项目文本和代码，保存有明确来源的决策与约束，持久化任务检查点，并通过 MCP 为当前任务组装聚焦的项目上下文。

## 个人存储能力（v0.8.0）

- 由用户明确选择持久化存储位置，MCP 服务不会静默初始化
- Codex、Claude Code、Cursor 及其他 MCP 客户端共享项目注册表
- 项目数据库随项目存放在 `<project>/.project-context/project.db`
- 使用 SQLite WAL，并结合 FTS5、Unicode n-gram 与代码关系搜索
- 将覆盖率归一化的 n-gram 排名、FTS 结果和精确符号名加权合并
- 增量索引支持 `.gitignore` 和 `.project-context-ignore`，并在目录层提前剪枝
- 每项目索引锁、MCP 取消操作和进度通知
- 旧版 n-gram 迁移延迟到 `project_index`，采用可取消、有界事务的批量重建
- 根据项目根目录识别并排除 Codex 运行会话、缓存、日志、附件和本地密钥存储
- 为已索引文本块建立外键索引，保证大型数据库中的来源清理行为可预期
- 默认排除 `.env`、凭据、私钥、数据库、二进制文件、生成目录和大文件
- 默认排除 `.d` 依赖文件、`.o/.obj` 目标文件、`.a/.lib` 静态库、字节码、编译缓存和覆盖率/性能分析产物
- 使用 Tree-sitter 索引 TypeScript、TSX、JavaScript、JSX、MJS 和 CJS 符号
- 搜索与任务上下文包含导入、调用、继承和实现关系
- 自动检测 Git、Mercurial（hg）和 Subversion（svn），记录版本、分支、工作区状态与差异哈希证据，但不持久化完整 diff
- 从 Git、Mercurial、Subversion 变更、已索引知识文档和已完成任务生成待审核记忆候选
- 各类版本控制与无版本控制项目均支持稳定的候选去重和文档候选替代
- 文件来源发生变化或消失时，将关联的活跃记忆标记为过期
- 使用段落指纹，避免大文件中无关内容变化导致记忆失效
- 支持结构化记忆类型、生命周期状态和决策替代关系
- 原生用户记忆支持 `user`、`workspace`、`project`、`module` 和 `task` 作用域
- 支持跨会话任务和检查点
- 本地工作台支持候选接受/拒绝、过期记忆清理、任务完成/取消以及索引监听控制
- `project_context` 按任务相关性组装上下文，包含关联代码符号并严格执行 Token 预算
- 选择与任务相关的作用域约束，同时保留作用域为空的项目级约束
- 本地确定性质量评估覆盖检索、上下文选择、记忆候选和延迟
- 项目根目录和输出根目录使用显式允许列表，并校验符号链接后的真实输出路径
- MCP 工具提供结构化结果、输出 Schema、资源、资源模板和工作流提示词
- 支持版本化的原地数据库迁移、完整性诊断、FTS 修复、备份和 JSONL 导出
- 支持恢复为新项目，或在明确确认后覆盖已归档项目
- 支持项目重命名、归档、取消归档、迁移、删除预览和受保护的永久删除
- MCP 打开项目时自动同步索引并启动进程级监听，读取上下文和结束任务前刷新待处理变化
- 使用 scrypt 派生密钥的流式 AES-256-GCM 加密备份与恢复
- 安全的本地主机项目工作台，包含项目画像、作用域用户规则和上下文预览
- CLI 与 stdio MCP 服务共用同一套核心实现

LSP、向量嵌入、远程存储和团队同步仍属于后续规划。当前已提供本地 Web 管理工作台。

## 环境要求

- Node.js 22 或更高版本
- npm 10 或更高版本

## 安装与构建

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run eval
npm run benchmark
```

## 质量评估

`npm run eval` 会创建隔离的临时项目，确定性测量英文和 CJK 文档检索、精确代码符号检索、活跃记忆检索、作用域上下文选择、候选记忆的准确率与召回率、Token 预算合规性以及本地延迟。任何质量指标未达阈值时，命令都会以非零状态退出。评估不使用网络服务、嵌入模型或外部项目数据。

`npm run benchmark` 会执行 100 次查询和上下文迭代，并输出只包含耗时的 JSON。延迟与机器环境相关，应在没有竞争负载的同一主机上比较；质量指标才是可移植的回归门槛。

评估报告保存在 `docs/baselines/v0.3.1.json` 和 `docs/baselines/v0.4.0.json`。在确定性测试数据上，v0.4.0 将搜索 MRR 从 `0.707` 提升到 `0.900`，Top-1 召回率从 `0.600` 提升到 `0.800`，已选择记忆的准确率从 `0.667` 提升到 `1.000`；同时 Recall@5、必需记忆召回率、候选准确率、候选召回率和候选类型准确率均保持 `1.000`。

## 选择记忆存储位置

运行交互式初始化程序：

```powershell
node dist/cli.js init
```

初始化程序用于选择共享注册表数据和恢复备份的存储位置。项目数据库始终位于 `<project>/.project-context/project.db`。可选位置包括：

1. 用户目录，推荐：`%USERPROFILE%\.project-context`
2. 当前项目：`<project>\.project-context`
3. 自定义绝对路径

自动化环境可使用：

```powershell
node dist/cli.js init --storage user --allow-project-root D:\project
node dist/cli.js init --storage project --project-root D:\project\my-app
node dist/cli.js init --storage D:\ProjectMemory --allow-project-root D:\project --allow-output-root D:\ProjectMemory
```

`PROJECT_CONTEXT_HOME` 可在临时或隔离环境中覆盖共享注册表和恢复目录。使用该变量时，请配置 `PROJECT_CONTEXT_ALLOWED_ROOTS` 和 `PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS`：Windows 使用分号分隔，POSIX 使用冒号分隔。升级后，已注册项目仍可继续使用；注册新项目时，其路径必须位于允许的根目录中。

## CLI 工作流

```powershell
# 注册项目并保存返回的项目 ID
node dist/cli.js project open D:\project\my-app

# 执行增量索引
node dist/cli.js index <project-id>

# 或保持显式的进程生命周期文件监听
node dist/cli.js watch <project-id> --debounce 300

# 在系统浏览器中打开本地工作台
node dist/cli.js ui

# 搜索已索引内容、代码符号和活跃记忆
node dist/cli.js search <project-id> "refresh token"

# 索引文档或完成任务后，审核有来源的候选记忆
node dist/cli.js memory candidates <project-id>
node dist/cli.js memory accept <project-id> <candidate-id>

# 取消不再继续的跨会话任务并保留最后检查点
node dist/cli.js task cancel <project-id> <task-id>

# 保存一条有来源的决策
node dist/cli.js memory add <project-id> `
  --type decision `
  --title "Rotate refresh tokens" `
  --content "Refresh tokens rotate after every successful use." `
  --source-kind user

# 保存跨项目共享的偏好
node dist/cli.js user-memory add `
  --type preference `
  --title "Test runner" `
  --content "Prefer Vitest for TypeScript projects." `
  --source-kind user `
  --scope-level user

# 开始任务并在之后恢复
node dist/cli.js task start <project-id> "Implement token reuse detection"
node dist/cli.js task checkpoint <project-id> <task-id> `
  --completed "Added token family" `
  --next "Add reuse test" `
  --changed-file "src/auth/auth.service.ts"

# 为新会话组装任务上下文
node dist/cli.js context <project-id> "Continue token reuse detection"

# 诊断并修复派生的 FTS 索引
node dist/cli.js doctor <project-id> --repair

# 创建持久化运维副本；目标必须是新的绝对路径或空目录
node dist/cli.js backup <project-id> D:\ProjectMemoryBackups\my-app.db
node dist/cli.js export <project-id> D:\ProjectMemoryExports\my-app

# 避免将口令写入命令历史或进程参数
$env:PROJECT_CONTEXT_BACKUP_PASSPHRASE = "<a strong private passphrase>"
node dist/cli.js backup-encrypted <project-id> D:\ProjectMemoryBackups\my-app.pcmb `
  --passphrase-env PROJECT_CONTEXT_BACKUP_PASSPHRASE
node dist/cli.js project restore-encrypted D:\ProjectMemoryBackups\my-app.pcmb `
  --passphrase-env PROJECT_CONTEXT_BACKUP_PASSPHRASE `
  --root D:\project\restored-app
```

项目删除被设计为两个步骤：先归档，再调用不带 `--purge` 的 `project delete` 检查影响数量，最后使用精确的项目 ID 确认执行永久删除。存在活跃记忆、进行中任务或待审核候选时，永久删除会被阻止。项目目录缺失不会触发自动删除。

## 本地项目工作台

`project-context ui` 会启动一个仅绑定到 `127.0.0.1` 的临时 HTTP 服务，自动选择可用端口并打开系统浏览器。项目画像汇总索引健康状态、代码智能、文件类型、Git 状态、记忆、候选、任务和主要索引来源，并可直接执行增量索引、控制进程级 watcher、审核候选、清理过期记忆以及结束历史任务。监听开启时，当前项目画像会自动刷新索引与记忆状态。索引过滤编辑器支持常用规则快捷添加、Windows 路径规范化和保存前影响预览，确认后将规则原子写入 `.project-context-ignore` 并立即更新索引。工作台还可以管理 `user`、`workspace`、`project`、`module` 和 `task` 作用域规则。

### Windows 一键启动

在仓库根目录双击 [`start-web.cmd`](start-web.cmd)，即可启动本地工作台并自动打开系统浏览器。启动器会以自身所在目录作为项目目录；如果 `dist/cli.js` 尚不存在，则会先使用已有依赖执行 `npm run build`。首次使用仍需在仓库中执行一次 `npm install`。

需要桌面入口时，右键单击 `start-web.cmd`，选择“发送到 > 桌面快捷方式”。工作台运行期间请保留命令窗口；按 `Ctrl+C` 或关闭窗口即可停止服务。不要收藏或复制某次启动产生的完整 URL 作为固定入口，因为端口和启动令牌属于当前服务进程；以后仍应通过启动器打开工作台。

### macOS 一键启动

在仓库根目录双击 [`start-web.command`](start-web.command)，即可启动本地工作台并自动打开默认浏览器。启动器兼容 Apple Silicon 和 Intel Homebrew 的常见 Node.js 安装路径，并与 Windows 版本一样在缺少 `dist/cli.js` 时使用已有依赖自动构建。

如果文件不可执行，请在终端中运行一次 `chmod +x start-web.command`。如果 macOS 首次阻止打开，请在 Finder 中按住 `Control` 单击该文件，选择“打开”并确认。工作台运行期间请保留终端窗口；按 `Control+C` 或关闭窗口即可停止服务。首次使用仍需在仓库中执行一次 `npm install`，并且不应收藏某次启动产生的临时完整 URL。

项目画像包含基于 Cytoscape.js 的交互式关系图。文件级视图会聚合项目依赖，而不是将每条原始关系都发送到浏览器；选择或搜索文件及符号后，可以按需展开一跳或两跳符号邻域。节点可自由拖拽，画布支持平移、缩放、适配，以及力导向、分层和环形布局。`IMPORTS`、`CALLS`、`EXTENDS`、`IMPLEMENTS` 关系可以独立筛选，节点详情会关联到已索引的源码路径和行号。

编辑活跃规则会创建新版本并将旧版本标记为 `superseded`；停用规则使用可审计的 `deleted` 生命周期状态，而不是物理删除。已被替代的历史版本不能重新激活为第二个活跃版本。

上下文预览会针对选定项目和模拟任务运行真实的 `project_context` 流程，展示选中的用户规则、项目约束与决策、活跃任务检查点、索引证据、警告以及实际 Token 预算使用情况。

浏览器会话使用随机启动令牌，并将其交换为 `HttpOnly`、`SameSite=Strict` Cookie。API 会校验 `Host`、同源状态变更请求、自定义 UI 请求头、JSON Schema 和 64 KiB 请求体上限。服务返回严格的内容安全策略，并且不会监听 `0.0.0.0`。`project-context ui --no-open` 仅供自动化使用，它会将一次性启动 URL 输出到终端。

## 小白教程：接入 MCP 客户端并自动初始化项目

Project Context MCP 不绑定某一个 AI 客户端。Codex、Claude Code、Cursor 以及其他支持 stdio MCP 的客户端都可以连接同一套本地项目数据。

这里的“默认启动”分为两层：先在所用客户端中注册 MCP 服务，再通过该客户端的全局会话规则，引导它在仓库首个任务中调用 `project_open` 和 `project_context`。`project_open` 会在 MCP 内部完成首次或增量索引并启动变更监听，无需客户端单独调用 `project_index` 或 `project_watch_start`。仅启动客户端但不开始任务时，不会在后台扫描磁盘。

### 安装完成后还要配置什么

首次安装后需要完成下面 3 项一次性配置，缺少其中任何一项都可能导致客户端看得到 MCP、但没有真正打开和索引当前项目：

| 一次性配置 | 作用 | 完成标志 |
| --- | --- | --- |
| 初始化个人存储和允许的项目根目录 | 决定共享注册表、恢复目录和允许索引的代码目录 | `storage_status` 返回 `configured: true` |
| 将 MCP 注册到所用客户端 | 让 Codex、Claude Code 或其他客户端可以启动 `project-context-mcp` | 客户端的 MCP 列表中能看到 `project-context` |
| 将推荐区块加入客户端全局会话规则 | 引导客户端在仓库首个任务中调用 `project_open` | 新会话依次调用 `storage_status`、`project_open`、`project_context` |

常用客户端的全局会话规则位置：

| 客户端 | Windows | macOS/Linux |
| --- | --- | --- |
| Codex | `%USERPROFILE%\.codex\AGENTS.md` | `~/.codex/AGENTS.md` |
| Claude Code | `%USERPROFILE%\.claude\CLAUDE.md` | `~/.claude/CLAUDE.md` |
| Cursor 或其他 MCP 客户端 | 使用客户端提供的全局 MCP 配置和 User Rules | 使用客户端提供的全局 MCP 配置和 User Rules |

这 3 项只需要为所用客户端配置一次。以后进入位于允许根目录下的任意仓库，直接描述正常开发任务即可，不需要修改项目提示词，也不需要手动调用 `project_index`、`project_watch_start` 或判断任务长短。MCP 会在 `project_open` 后托管当前进程的索引与 watcher；候选记忆仍需人工审核，不会自动进入正式上下文。

下面按顺序给出从安装到验证的完整命令。已经完成某一步的用户可以直接跳到下一步。

### 第 1 步：安装并构建

```powershell
git clone https://github.com/hh357418341-create/project_context_mcp.git D:\tools\project-context-mcp
cd D:\tools\project-context-mcp
npm install
npm run typecheck
npm test
npm run build
```

需要 Node.js 22 或更高版本。下面示例中的安装目录和项目根目录请替换为自己的绝对路径。

### 第 2 步：一次性初始化个人存储

Windows 示例：

```powershell
node dist/cli.js init --storage user --allow-project-root D:\project
```

macOS/Linux 示例：

```bash
node dist/cli.js init --storage user --allow-project-root "$HOME/code"
```

这一步只需执行一次。`--allow-project-root` 是允许注册项目的安全边界；有多个代码目录时可以在同一条命令后继续列出其他绝对路径。MCP 不会静默选择存储目录。

### 第 3 步：添加到所用 MCP 客户端

选择实际使用的客户端执行对应命令，不需要同时配置所有客户端。

#### Codex

推荐使用 Codex CLI，避免手写 TOML：

```powershell
codex mcp add project-context -- node D:/tools/project-context-mcp/dist/mcp/server.js
codex mcp get project-context
```

`codex mcp get project-context` 应显示 `enabled: true`。也可以手动编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.project-context]
type = "stdio"
command = "node"
args = ["D:/tools/project-context-mcp/dist/mcp/server.js"]
```

如果 `node` 不在 `PATH` 中，将 `command` 改为 Node 可执行文件的绝对路径。修改配置后，重启 Codex 或新建会话。

#### Claude Code

使用用户级 scope，配置会对当前用户的所有 Claude Code 项目生效：

```powershell
claude mcp add --scope user project-context -- node D:/tools/project-context-mcp/dist/mcp/server.js
claude mcp get project-context
```

`claude mcp get project-context` 应能显示该 stdio 服务。其他支持 stdio MCP 的客户端，请将命令设置为 `node`，参数设置为构建产物 `dist/mcp/server.js` 的绝对路径。

### 第 4 步：添加客户端全局会话规则

根据所用客户端创建或编辑对应文件：

- Codex：Windows 使用 `%USERPROFILE%\.codex\AGENTS.md`，macOS/Linux 使用 `~/.codex/AGENTS.md`；
- Claude Code：Windows 使用 `%USERPROFILE%\.claude\CLAUDE.md`，macOS/Linux 使用 `~/.claude/CLAUDE.md`；
- Cursor 或其他客户端：加入其全局 User Rules，不要只放在某一个项目的局部规则中。

加入下面的启动规则。若文件中已有个人规则，只追加这段，不要覆盖原内容。这里修改的是客户端的用户级全局规则，不是当前代码仓库里的局部规则文件。

```markdown
<!-- project-context-mcp:start -->
# Cross-session Project Context (project-context-mcp)

Use project-context-mcp to retain sourced project knowledge across AI coding sessions.

## Session Workflow
1. At the beginning of the first user turn in a repository, call `storage_status`.
2. Call `project_open` with the repository's absolute root path and reuse the returned project ID. The MCP server synchronizes the index and manages change tracking for the current process.
3. Before substantial implementation work, call `project_context` with the current task.
4. Use `project_search` for indexed text, symbols, memories, and code relationships instead of guessing. Managed pending changes are flushed before reads.
5. For non-trivial work, call `task_start`, save progress with `task_checkpoint`, and call `task_complete` when finished. Completion flushes pending project changes.

## Memory Rules
- Review `memory_candidates` after indexing Git changes. Accept or reject candidates explicitly; never accept them automatically.
- Use `memory_remember` only for durable decisions, constraints, lessons, or facts with a clear source.
- Never store credentials, private keys, tokens, full chat transcripts, or full Git diffs.
- Run `project_doctor` when stored context appears incomplete or inconsistent.
<!-- project-context-mcp:end -->
```

启动流程必须放在客户端启动任务前就能读取的用户级全局规则中，不能只放在 Project Context 工作台的“全局规则”中。工作台规则只有在 `project_context` 已被调用后才能返回，无法负责引导第一次 MCP 调用。

完成这一步后，不需要为每个项目重复添加相同区块，也不需要在日常任务提示词中写“请启动 watcher”或“修改后重新索引”。

### 第 5 步：验证第一次自动初始化

进入一个位于允许根目录下、尚未注册的仓库，然后启动已经配置好的 MCP 客户端并发送第一条正常任务消息。按照上面的全局规则，客户端应依次调用：

```text
storage_status
project_open
project_context
```

验证结果：

- `project_open` 返回一个稳定的 `prj_...` 项目 ID；
- 项目中出现 `.project-context/project.db`；
- `project_open` 完成首次或增量索引，并在当前 MCP 进程中自动启动变更监听；
- `project_context` 返回与当前任务有关的记忆、规则、任务检查点和索引证据。

建议将 `.project-context/` 加入项目的 `.gitignore`。项目路径不在初始化时配置的允许根目录下时，`project_open` 会拒绝注册；重新运行 `init` 并显式加入正确根目录即可。

### MCP 托管索引不是永久后台服务

客户端会根据自身的 MCP 配置启动服务，并根据全局会话规则在首个任务中调用 `project_open`。MCP 会先完成增量索引，再为当前项目启动进程级 watcher；`project_search`、`project_context`、`task_complete` 和 `task_cancel` 会在执行前刷新待处理变化。客户端或 MCP 进程重启后旧 watcher 不会恢复，但下一次 `project_open` 会重新同步并启动新的 watcher。CLI 仍保留显式的 `index` 和 `watch` 工作流。

客户端配置细节可参考对应官方文档：Codex 的 [MCP](https://developers.openai.com/codex/mcp/) 与 [Customization / AGENTS.md](https://developers.openai.com/codex/concepts/customization/)，以及 Claude Code 的 [MCP](https://docs.anthropic.com/en/docs/claude-code/mcp) 文档。

## MCP 工具（35 个）

- `storage_status`
- `project_open`、`project_list`、`project_update`、`project_archive`、`project_unarchive`、`project_relocate`
- `project_delete`、`project_restore`、`project_restore_encrypted`
- `project_index`、`project_search`、`project_context`、`project_health`
- `project_watch_start`、`project_watch_stop`、`project_watch_list`
- `project_doctor`、`project_backup`、`project_backup_encrypted`、`project_export`
- `memory_remember`、`memory_list`、`memory_update_status`
- `memory_candidates`、`memory_candidate_accept`、`memory_candidate_reject`
- `user_memory_remember`、`user_memory_list`、`user_memory_update_status`
- `task_start`、`task_checkpoint`、`task_list`、`task_complete`、`task_cancel`

`project_index` 会返回符号与关系总数、过期记忆 ID、新生成的候选以及 Git 元数据。索引和 watcher 会跳过常见跨语言编译产物，包括 C/C++ 的 `.d` 依赖文件、`.o/.obj` 目标文件、`.a/.lib` 静态库、预编译头、Java/Python 字节码以及覆盖率和性能分析输出。存在 Git 时优先使用 Git 证据；没有 Git 的项目仍可以根据新增或修改的知识文档生成候选。每个已完成任务最多生成一条候选，依次优先使用任务摘要、第一条风险和第一条明确具有长期价值的已完成事项，避免把普通执行记录拆成多条待审记忆。系统不会返回或保存完整 diff。候选记忆在调用 `memory_candidate_accept` 前始终只处于待审核状态。

打开 Schema v4 之前创建的数据库时，只会创建 n-gram 表并立即返回。现有内容会在下一次 `project_index` 中通过小批量提交重建，期间 MCP 取消和进度报告保持有效。中断的重建会继续标记为未完成，并在之后的索引运行中安全重试。`project_doctor` 会报告该状态，也可以显式修复。

Schema v5 为 `chunks(source_id)` 添加索引，使来源删除和外键检查只与受影响的文本块数量相关，避免反复扫描整个文本块表。

项目 Schema v6 为文件来源记忆绑定增加段落摘录和摘录哈希。当整文件哈希变化但标准化后的来源段落仍然存在时，绑定会更新文件哈希与行号范围并保持活跃；段落变化或缺失时则变为 `stale`。没有摘录的旧版绑定继续使用保守的整文件失效策略。注册表 Schema v2 增加项目归档状态和用户记忆。

MCP 的 `project_open` 会完成索引并自动启动受控 watcher；显式的 `project_watch_start`、`project_watch_stop` 和 `project_index` 继续作为诊断与手动控制接口。watcher 只在 MCP 或 CLI 进程生命周期内存在，会忽略内部数据库、版本控制元数据、依赖和常见构建目录，对其余文件事件防抖并运行相同的增量索引。它不会接受记忆候选；MCP 连接关闭时会释放 watcher。

加密备份使用带版本号的认证格式，包含随机盐和 IV、scrypt 密钥派生以及 AES-256-GCM。MCP 和 CLI 只接受环境变量名称 `passphraseEnv`，不接受原始口令。口令不会被存储，因此一旦丢失，备份将无法恢复。无论成功还是失败，明文临时备份文件都会被删除。

当注册的项目根目录本身名为 `.codex` 时，系统会自动排除 `sessions`、`.tmp`、`plugins/cache`、日志、附件、SQLite 状态和密钥存储等运行时目录。普通应用仓库中的同名目录仍可被索引。

所有工具都会同时返回向后兼容的 JSON `TextContent` 和经过校验的 `structuredContent`。

## MCP 资源与提示词

- 静态项目注册表：`project-context://projects`
- 项目健康状态、单条记忆、任务和索引来源的资源模板
- 用于任务上下文和检查点恢复的 `resume-project-task` 提示词
- 用于显式审核候选的 `review-memory-candidates` 提示词

## 存储结构

```text
<storage-root>/
├── registry.db
└── recovery/
    └── <project-id>-<timestamp>.db

<project-root>/
└── .project-context/
    └── project.db
```

`registry.db` 保存项目注册信息和用户级记忆。每项目数据库保存索引、项目记忆、候选审计记录和任务检查点。在覆盖已归档项目数据库或迁移旧版中央项目数据库前，系统会在 recovery 目录中创建内部安全备份。

注册表 Schema v3 会先创建经过校验的恢复快照，再将现有 `<storage-root>/projects/<project-id>/project.db` 迁移到对应项目根目录。`.project-context/` 始终不参与索引，并已加入仓库的 `.gitignore`。系统不会存储完整聊天记录、完整 Git diff、检测到的密钥值或加密口令。
