# Project Context MCP 简介

## 项目是什么

Project Context MCP 是一套面向 AI 编程助手的本地项目上下文与长期记忆工具链。它通过 MCP（Model Context Protocol）接入 Codex、Claude Code、Cursor 等客户端，帮助 AI 在不同会话之间持续理解同一个项目。

它解决的核心问题是：AI 编程助手在新会话中通常不知道项目之前做过什么、有哪些架构决策、当前任务进行到哪里，也无法直接复用其他客户端积累的项目知识。Project Context MCP 会在本地索引代码和文档，保存经过审核的长期记忆与任务检查点，并根据当前任务返回最相关的上下文。

> 一句话概括：Project Context MCP 是 AI 编程助手的本地项目大脑，让 AI 跨会话记住项目决策、开发进度和代码关系。

## 核心特点

- **本地优先**：项目索引、记忆和任务数据默认保存在本机 SQLite 数据库中。
- **跨客户端共享**：同一份项目上下文可供多个兼容 MCP 的 AI 客户端使用。
- **增量索引**：通过文件内容哈希识别变化，只处理新增、修改或删除的内容。
- **混合检索**：结合 SQLite FTS5、Unicode n-gram、精确符号匹配和代码关系排序。
- **中文检索**：使用 Unicode n-gram 支持中文子串检索，不依赖在线分词或向量服务。
- **代码智能**：通过 Tree-sitter 提取 JavaScript 和 TypeScript 的符号、调用、导入、继承与实现关系。
- **记忆可治理**：自动发现的信息先成为候选，只有经过明确审核后才会进入长期记忆。
- **任务可续接**：持久保存已完成事项、下一步、修改文件、验证结果、阻塞项和风险。
- **多级个人记忆**：原生支持 `user`、`workspace`、`project`、`module`、`task` 五种作用域。
- **来源可追溯**：文件记忆同时绑定整文件与引用段落指纹，减少无关改动导致的误过期。
- **数据生命周期完整**：支持项目归档、迁移、受保护删除，以及新项目恢复和原项目回滚。
- **索引自动托管**：MCP 打开项目时完成同步并自动监听，检索和任务结束前刷新变化，但绝不自动接受长期记忆候选。
- **备份可加密**：支持 scrypt + AES-256-GCM 的流式加密备份，口令不写入数据库或参数。
- **本地项目工作台**：通过仅监听本机的 Web UI 查看项目画像、治理候选/过期记忆/历史任务、控制索引与 watcher、编辑五级个人规则，并预览真实上下文组装结果。
- **安全边界明确**：默认排除密钥、凭据、数据库、二进制文件、构建产物和敏感路径。

## 工作原理

```text
项目代码与文档
      ↓
安全过滤与增量索引
      ↓
全文检索 + 中文 n-gram + 代码符号关系
      ↓
长期记忆 + 候选审核 + 跨会话任务
      ↓
按当前任务组装相关上下文
      ↓
Codex / Claude Code / Cursor 等 MCP 客户端
```

一个典型工作流如下：

1. 初始化本地存储。
2. 注册项目并获得稳定的项目 ID。
3. 增量索引项目代码、文档和配置。
4. 搜索相关内容，或根据当前任务组装上下文。
5. 在开发过程中保存任务检查点。
6. 审核由 Git、文档变化或任务总结生成的记忆候选。
7. 在后续会话中恢复任务并继续开发。
8. 定期创建加密备份，并实际演练恢复。

## MCP 工具链

项目当前提供 35 个 MCP 工具。

### 存储与项目管理

| 工具 | 作用 |
| --- | --- |
| `storage_status` | 检查持久化存储是否已配置 |
| `project_open` | 注册或重新打开项目，并返回项目 ID |
| `project_list` | 列出项目，可选择包含已归档项目 |
| `project_update` | 修改项目显示名称 |
| `project_archive` / `project_unarchive` | 归档或恢复项目登记状态，不删除数据 |
| `project_relocate` | 项目目录移动后更新受授权的新路径 |
| `project_delete` | 预览或在多重保护下永久清除已归档项目 |
| `project_restore` | 验证并恢复普通 SQLite 备份 |
| `project_restore_encrypted` | 从认证加密备份恢复项目 |
| `project_index` | 增量索引项目文件、符号和代码关系 |
| `project_search` | 搜索项目内容、代码符号和长期记忆 |
| `project_context` | 根据当前任务组装最相关的项目上下文 |
| `project_health` | 查看项目、索引、记忆、任务和最近运行状态 |
| `project_watch_start` / `project_watch_stop` / `project_watch_list` | 管理进程存活期内的去抖自动索引 |
| `project_doctor` | 检查并修复数据库与派生搜索索引 |
| `project_backup` | 在线备份项目 SQLite 数据库 |
| `project_backup_encrypted` | 创建 scrypt + AES-256-GCM 加密备份 |
| `project_export` | 将项目知识导出为 JSONL 文件 |

### 长期记忆管理

| 工具 | 作用 |
| --- | --- |
| `memory_remember` | 保存一条有来源的长期记忆 |
| `memory_list` | 按生命周期状态列出记忆 |
| `memory_update_status` | 修改记忆状态 |
| `memory_candidates` | 查看等待审核的记忆候选 |
| `memory_candidate_accept` | 接受候选并创建正式记忆 |
| `memory_candidate_reject` | 拒绝候选并保留审核记录 |

长期记忆可以表示事实、决策、约束、偏好、经验、问题、假设和任务总结。其生命周期包括 `candidate`、`active`、`superseded`、`stale`、`conflicted`、`rejected` 和 `deleted`。

### 个人级记忆管理

| 工具 | 作用 |
| --- | --- |
| `user_memory_remember` | 保存一条带明确作用域的个人记忆 |
| `user_memory_list` | 按状态列出个人记忆 |
| `user_memory_update_status` | 调整个人记忆的生命周期状态 |

五级作用域的含义如下：

| Scope | 适用范围 | 必要定位信息 |
| --- | --- | --- |
| `user` | 当前用户的全部项目 | 无 |
| `workspace` | 某个绝对目录及其子项目 | `scopeRef` 为绝对路径 |
| `project` | 单个已登记项目 | `projectId` |
| `module` | 单项目内某个模块主题 | `projectId` + `scopeRef` |
| `task` | 单项目内某类任务 | `projectId` + `scopeRef` |

组装上下文时，系统先筛掉不属于当前项目的记忆，再按当前任务匹配模块和任务作用域，最终把个人约束与项目记忆放进同一个 token budget。概念上的组合顺序是：

```text
user 全局约束
  + workspace 工作区约束
  + project 项目偏好
  + module 当前模块决策
  + task 当前任务规则
  + 项目长期记忆
  + 进行中的 task checkpoint
  + 当前文件片段和代码关系
  = 本次 project_context 快照
```

这不是把所有记忆无条件注入对话。`module` 和 `task` 的 `scopeRef` 必须能匹配当前任务文本；不同 `projectId` 的项目、模块和任务记忆不会互相泄漏；最终仍受相关性排序和 token budget 限制。

### 跨会话任务管理

| 工具 | 作用 |
| --- | --- |
| `task_start` | 创建一个可跨会话持续的项目任务 |
| `task_checkpoint` | 保存任务进度、验证结果、风险和下一步 |
| `task_list` | 查询进行中或已完成的任务 |
| `task_complete` | 完成任务并保留最终检查点 |
| `task_cancel` | 取消不再继续的任务并保留最终检查点 |

任务检查点支持记录：

- 当前总结；
- 已完成事项；
- 下一步工作；
- 修改过的文件；
- 实际执行的验证命令与结果；
- 阻塞项；
- 残余风险。

## 搜索与上下文能力

`project_search` 会合并多种本地检索信号：

- SQLite FTS5 全文检索；
- Unicode n-gram 中文和子串检索；
- 函数、类、接口和方法等代码符号检索；
- 精确符号名称加权；
- import、call、extends、implements 等代码关系；
- 已确认的活跃长期记忆。

`project_context` 则面向具体任务进行选择和排序。它会组合相关约束、决策、经验、问题、任务检查点、代码片段和符号关系，并严格遵守调用方提供的 token budget，避免向模型发送大量无关内容。

## 记忆审核机制

系统坚持“自动发现、人工确认”的原则：

```text
Git 变更 / 项目文档 / 已完成任务
                ↓
          生成记忆候选
                ↓
            人工审核
          ↙           ↘
       接受             拒绝
        ↓                ↓
   正式长期记忆       保留审核记录
```

候选生成包含稳定去重、来源绑定、敏感内容过滤和旧候选替代机制。系统不会自动接受候选，也不会保存完整 Git diff 或完整聊天记录。

## 记忆系统如何协同

Project Context MCP 的“记忆”不是一个单独的文本列表，而是由个人记忆、项目索引、候选记忆、正式长期记忆、任务 checkpoint 和任务上下文共同组成的协作链路。各层承担不同职责，只有组合使用时才能同时兼顾自动化、准确性和跨会话连续性。

### 六层数据各自负责什么

| 层级 | 保存的内容 | 是否自动进入新对话 | 主要用途 |
| --- | --- | --- | --- |
| 个人级记忆 | 跨项目偏好，以及 workspace/project/module/task 范围规则 | 仅适用且为 `active` 时进入 | 回答“这个用户长期怎样工作” |
| 项目索引 | 文件片段、路径、行号、内容哈希、代码符号和关系 | 按检索相关性进入 | 回答“代码和文档现在是什么” |
| 记忆候选 | 从 Git、知识文档或任务总结中发现的待审核信息 | 不会 | 回答“这可能值得长期记住吗” |
| 正式长期记忆 | 已确认的事实、决策、约束、偏好、经验、问题和假设 | 仅 `active` 状态按相关性进入 | 回答“项目长期应该遵守什么” |
| 任务 checkpoint | 当前任务的完成项、下一步、文件、验证、阻塞和风险 | 进行中的任务可进入 | 回答“上一次开发做到哪里” |
| 临时任务上下文 | 当前请求相关的记忆、任务、文件片段和代码关系 | 只存在于本次调用结果中 | 为当前 AI 会话提供最小必要上下文 |

这六层的关系可以表示为：

```text
项目文件发生变化
       ↓
project_index 更新文件、符号、关系和内容哈希
       ↓
从 Git / 知识文档生成 pending 候选
       ↓
人工审核候选
   ↙               ↘
接受                 拒绝
 ↓                     ↓
active memory       rejected 审核记录
       ↓
project_context 根据新任务选择相关记忆
       ↑                         ↑
适用的 user memory      进行中的 task checkpoint
       ↓
AI 获得“个人偏好 + 当前代码 + 长期规则 + 历史进度”
```

### 为什么候选不能直接进入新对话

候选内容来自启发式提取。它可能很准确，也可能把说明文档中多个看似耐久、实际无关的句子组合在一起。如果未经审核就自动用于后续开发，错误信息会被反复放大。

因此 `pending` 候选只会通过以下入口出现：

- `memory_candidates` 工具；
- `review-memory-candidates` 工作流 Prompt；
- `project_index` 返回值中的 `generatedCandidates`。

普通的 `project_search` 和 `project_context` 不会把 `pending`、`rejected` 或 `superseded` 候选当作正式记忆使用。只有执行 `memory_candidate_accept` 后，系统才会基于候选创建一条 `active` 长期记忆；执行 `memory_candidate_reject` 则只保留拒绝记录。

### 新对话如何拿到以前的记忆

“在新对话中提到相同内容”本身不会触发记忆注入。客户端需要满足以下条件：

1. 连接到保存该项目数据的同一个 Project Context MCP 实例；
2. 使用同一个项目 ID；
3. 调用 `project_context` 或 `project_search`；
4. 目标记忆处于 `active` 状态；
5. 记忆与当前任务、查询文本或 scope 足够相关；
6. 记忆能在本次 token budget 内被选中。

推荐的新会话流程是：

```text
storage_status
      ↓
project_open（复用返回的 projectId）
      ↓
project_context（传入这次要做的任务）
      ↓
AI 使用返回的 active memories、checkpoint 和相关代码
```

即使一条记忆是 `active`，它也不会无条件进入所有对话。例如认证模块的决策通常会进入“修改登录流程”的上下文，但不应进入“调整首页间距”的上下文。带 scope 的约束只在任务与其适用范围相关时选取；scope 为空的项目级约束可以跨模块参与选择。系统还会通过 token budget 限制最终上下文，优先保留更相关的信息。

### 同一对话中的每一轮是否都会重新组装

不会。MCP 服务不知道用户正在进行第几轮对话，也不会监听聊天窗口或在每条消息之后主动推送上下文。`project_context` 是一个普通的只读 MCP 工具，只有客户端或 AI 在某一轮显式调用它时才会执行一次组装。

需要区分三个概念：

| 概念 | 含义 |
| --- | --- |
| 对话 | 用户与 AI 持续交流的整个会话，通常包含之前的消息和工具结果 |
| 一轮 | 用户发送一条消息，AI 处理并回复一次 |
| 一次组装 | AI 调用一次 `project_context(projectId, task, budgetTokens)`，MCP 返回当时的上下文快照 |

一次典型对话可能是：

```text
第 1 轮：用户说“继续实现登录功能”
  AI 调用 project_context("继续实现登录功能")
  MCP 返回快照 A

第 2 轮：用户补充“错误提示改成中文”
  AI 已经拥有上一轮消息和快照 A
  通常不需要再次调用 project_context

第 3 轮：用户切换到“检查数据库备份”
  任务主题明显变化
  AI 再次调用 project_context("检查数据库备份")
  MCP 返回与备份相关的快照 B

第 4 轮：AI 修改文件并运行 project_index
  索引、候选或 stale 状态可能变化
  如果后续工作依赖最新状态，可以再次调用 project_context
```

工具返回的是调用时的**静态快照**，不是对数据库的实时引用。例如快照 A 返回后，即使另一个客户端接受了新记忆、更新了 checkpoint 或重新索引了文件，已经返回到当前对话里的快照 A 也不会自动变化。需要再次调用 `project_context` 才能获得快照 B。

同一对话中，前一轮的工具结果通常仍在模型的聊天上下文里，所以没有必要每句话都重复组装。对话很长时，客户端可能压缩或截断旧消息；这时重新调用可以恢复一份最新、结构化的项目上下文。

推荐在以下时机重新组装：

- 新会话开始，并准备进行实质性项目工作；
- 用户把任务切换到另一个模块或问题域；
- 完成 `project_index` 后，文件、候选或 stale 状态已经变化；
- 接受、拒绝、替代或手动更新了长期记忆；
- 其他客户端可能更新了同一项目的任务或记忆；
- 对话过长，早期项目上下文可能已被压缩；
- AI 发现当前信息与代码现状矛盾，需要刷新证据。

通常不需要在以下情况重新组装：

- 用户只是澄清上一条消息中的一个细节；
- 当前任务、文件和记忆都没有变化；
- AI 仍能直接看到上一轮返回的上下文；
- 只是执行同一任务中的连续小步骤。

### 一次组装内部到底做了什么

每次调用接收三个关键参数：

```text
projectId    要读取哪个项目数据库
task         当前任务的自然语言描述
budgetTokens 本次最多返回多少近似 token
```

MCP `project_context` 和 `resume-project-task` 提示在省略预算时默认使用 3,000 tokens。上下文组装会先按任务相关性检索并限制记忆、任务、命中片段和代码关系的候选数量，再进入最终预算裁剪；这样大量无关历史不会先被整体加载。需要更完整资料时可以显式传入更高的 `budgetTokens`；上下文结果超过约 2,000 个字符时，MCP 的 JSON `TextContent` 只保留简短提示，完整数据仍位于经过校验的 `structuredContent.result`。

当前实现按以下顺序组装：

1. 选择适用于当前项目和任务的 `active` 个人记忆；
2. 使用 `task` 对文件片段、代码符号和 `active` 项目记忆执行混合检索，最多保留 24 个相关结果；
3. 先读取检索命中的项目记忆，再用最多 64 条最近 `active` 记忆补足项目级约束候选，不再预加载 200 条历史后统一截断；
4. 将任务文本拆成关键词，按任务相关性对项目记忆和个人记忆排序；
5. 选择最多 20 条项目级或任务相关的约束；
6. 选择最多 15 条与任务相关的决策；
7. 选择最多 10 条与任务相关的经验或已知问题；
8. 从最多 20 个 `in_progress` 任务候选中按相关性选择 10 个及其 checkpoint；
9. 根据前 12 个命中的代码符号补充最多 40 条 import、call、extends 和 implements 关系；
10. 如果存在 `stale`/`conflicted` 记忆或失败的索引运行，在结果中加入警告；
11. 将所有内容放入同一个 token budget，并裁剪到 `budgetTokens` 以内。

组装结果的主要结构是：

```json
{
  "project": "项目标识和根目录",
  "task": "本次用于组装的任务文本",
  "constraints": "相关约束",
  "decisions": "相关决策",
  "lessons": "相关经验和问题",
  "userMemories": "适用于当前项目和任务的个人记忆",
  "activeTasks": "进行中的任务 checkpoint",
  "relevant": "相关文件片段、符号和记忆搜索结果",
  "codeRelations": "代码关系",
  "warnings": "过期、冲突或索引失败提示",
  "budget": "请求、使用和是否裁剪"
}
```

`fact`、`preference`、`assumption` 和 `task-summary` 等其他活跃记忆类型虽然没有独立顶层数组，但仍可通过混合检索出现在 `relevant` 中。

如果结果超过预算，系统会逐步减少相关搜索结果、代码关系、经验、决策、约束和任务数量，然后缩短过长文本。极端情况下仍无法满足预算时，会移除详细内容并返回警告。`project_context` 本身不会写入数据库，也不会自动改变任何记忆状态。

可以把它理解成：

> 每次调用 `project_context`，都是拿当前任务作为搜索问题，到项目数据库中临时制作一份“本轮 AI 最值得阅读的项目资料包”。资料包不会自动更新，也不是永久塞进每一轮对话；任务或底层数据变化后，需要按需重新制作。

### 长期信息的来源

正式记忆的来源决定了它如何追踪变化：

| `sourceKind` | 常见来源 | 自动变化检测 |
| --- | --- | --- |
| `file` | README、ADR、架构文档和其他已索引文件 | 支持文件哈希漂移检测 |
| `git` | Git 变更中提取的候选 | 保存 Git 证据，但当前不按后续 commit 自动失效 |
| `tool` | 已完成任务的 summary、risk 或耐久完成项 | 不因文件变化自动失效 |
| `user` | 用户明确保存的事实或决策 | 不因文件变化自动失效 |
| `inference` | 工具或模型明确标注的推断 | 不因文件变化自动失效，默认置信度更低 |

`user`、`tool`、`git` 和 `inference` 来源的记忆需要通过 `memory_update_status` 手动调整，或由一条带 `supersedesId` 的新记忆明确替代。

### 文件来源记忆如何失效

接受或创建 `sourceKind="file"` 的记忆时，系统会绑定当时的：

```text
sourceRef  = README.md:10
sourceId   = 已索引文件 ID
sourceHash = 当时整个 README.md 的内容哈希
excerpt    = sourceRef 所在段落的规范化文本
excerptHash = 引用段落指纹
```

文件保存后不会立即改变记忆状态。只有下一次运行 `project_index`，系统才会重新索引来源并执行漂移检查：

```text
文件发生变化
      ↓
记忆暂时仍是 active
      ↓
运行 project_index
      ↓
先比较整文件哈希；变化时再寻找原引用段落
      ↓
段落仍存在                 段落变化或来源消失
    ↓                            ↓
刷新文件哈希和行号、保持 active   active → stale
```

以下情况会让文件来源的 `active` 记忆变为 `stale`：

- 引用段落本身发生变化或不再存在；
- 文件被删除；
- 文件开始被 `.gitignore` 或 `.project-context-ignore` 排除；
- 文件路径被安全策略认定为敏感；
- 文件变成二进制、超过大小限制或因其他原因不再被索引；
- 记忆绑定的来源记录丢失；
- 旧版记忆没有段落指纹，且记忆保存时的整文件哈希与最新文件哈希不一致。

例如记忆引用 `README.md:10`，在 README 开头增加说明但原段落未变化时，系统会找到移动后的同一段落，刷新文件哈希和行号，记忆继续保持 `active`。只有引用段落改变、消失或来源不再可索引时才会变成 `stale`。Schema v6 以前创建、没有段落指纹的绑定继续使用保守的整文件哈希规则。

`stale` 记忆不会被默认的 `memory_list`、`project_search` 或 `project_context` 当作活跃知识使用。它仍保留在数据库中，便于审计和人工判断。

### 候选更新为什么使用 superseded

候选尚未成为正式知识，因此来源文档变化时不使用 `stale`，而是保留新版本、替代旧版本。

例如第一次索引产生：

```text
候选 A
内容：Decision: use local storage.
状态：pending
来源：README.md
```

README 后来改为：

```text
Decision: use encrypted local storage.
```

再次运行 `project_index` 后，状态会变成：

```text
候选 A：pending → superseded
候选 B：新内容 → pending
```

旧候选不会被物理删除，而是作为审计记录保留；审核列表只需要关注最新的 `pending` 候选。未发生变化的文档再次索引时，稳定指纹会阻止重复候选。

因此应这样区分：

| 场景 | 状态变化 |
| --- | --- |
| 待审核文件候选的来源更新 | 旧 `pending` → `superseded`，生成新 `pending` |
| 已接受文件记忆的无关位置更新，引用段落未变 | 刷新绑定，保持 `active` |
| 已接受文件记忆的引用段落更新 | `active` → `stale` |
| 新决策明确替代旧决策 | 旧记忆 → `superseded`，新记忆 → `active` |
| 候选被人工接受 | 候选 → `accepted`，同时创建 `active` 记忆 |
| 候选被人工拒绝 | 候选 → `rejected` |

### 任务 checkpoint 如何补足长期记忆

长期记忆适合保存稳定规则，但不适合记录每一步临时进度。任务 checkpoint 专门负责短中期连续性：

```text
task_start
    ↓
开发与验证
    ↓
task_checkpoint
    ├── completed
    ├── next
    ├── changedFiles
    ├── verification
    ├── blockers
    └── risks
    ↓
新会话通过 project_context 恢复进度
    ↓
task_complete
```

任务完成时，系统最多生成一条候选：优先使用 summary，其次使用第一条 risk，最后才使用第一条明确耐久的 completed 项。候选仍然必须经过人工审核，防止把“重启服务”“稍后再测”之类的临时操作变成永久项目记忆；同一候选的重复拒绝会幂等返回已有审核结果。

这形成了职责分工：

- checkpoint 记录“这次做到哪里”；
- active memory 记录“以后都应该知道什么”；
- project index 记录“代码和文档现在是什么”；
- project context 负责在每次新任务中把三者组合起来。

### 一个完整示例

假设认证文档新增：

```text
Decision: refresh tokens rotate after every successful use.
```

完整链路如下：

1. `project_index` 发现认证文档变化并更新文件索引；
2. 系统生成一条 `pending` 决策候选；
3. 该候选不会进入普通新对话；
4. 人工检查来源后调用 `memory_candidate_accept`；
5. 候选变为 `accepted`，同时创建 `active` 决策记忆；
6. 开发者通过 `task_start` 开始实现令牌轮换；
7. `task_checkpoint` 保存修改文件、测试结果和下一步；
8. 新会话调用 `project_context("继续实现 refresh token rotation")`；
9. 系统组合认证决策、进行中的 checkpoint、相关函数和调用关系；
10. 如果认证文档后来变化，下一次 `project_index` 会把旧文件记忆标记为 `stale`，并可能生成新的 `pending` 候选；
11. 人工审核新版候选后，新的 `active` 记忆替代旧结论。

这套组合机制的目标不是让系统“记住所有东西”，而是让它只长期保存经过确认的知识，在来源变化时停止盲目信任旧内容，并在每次任务中按需取回最相关的部分。

## MCP 资源与工作流 Prompt

除工具调用外，项目还提供 MCP Resources 和 Prompts：

- 项目注册表资源：读取已登记的项目；
- 项目健康资源：读取指定项目的健康状态；
- 单条记忆资源：读取记忆详情；
- 任务资源：读取任务及其检查点；
- 索引源资源：读取已索引来源的信息；
- `resume-project-task`：指导 AI 恢复并继续跨会话任务；
- `review-memory-candidates`：指导 AI 审核待处理的记忆候选。

静态项目注册表 URI：

```text
project-context://projects
```

## 本地规则管理界面

运行下面的命令会在随机可用端口启动只监听 `127.0.0.1` 的服务，并打开系统浏览器：

```powershell
node dist/cli.js ui
```

界面提供两个工作区：

| 视图 | 能力 |
| --- | --- |
| 项目画像 | 汇总项目身份、索引状态、代码规模、文件类型、Git 状态、记忆、候选、任务和主要来源；支持增量索引、watcher 启停、候选审核、过期记忆清理、任务完成/取消；关系图支持拖拽、缩放、筛选、搜索、布局切换和按需展开符号邻居 |
| 规则 | 按 `user`、`workspace`、`project`、`module`、`task` 浏览、搜索、新建、版本更新、停用和重新启用规则 |
| 上下文预览 | 选择项目和模拟任务，运行真实 `project_context`，查看个人规则、项目记忆、checkpoint、代码证据和 token 使用量 |

修改活跃规则不会覆盖原记录，而是创建带 `supersedesId` 的新版本；旧版本进入 `superseded` 状态。停用使用 `deleted` 软删除，只有被软删除的版本可以重新启用，`superseded` 历史不能直接复活成第二个活跃版本。

UI 的安全边界包括：

- 固定绑定 `127.0.0.1`，不暴露到局域网或公网；
- 启动时生成随机令牌，通过 URL fragment 进入浏览器，不发送到 HTTP 日志；
- 令牌交换为 `HttpOnly`、`SameSite=Strict` 会话 Cookie 后立即从地址栏移除；
- 校验 `Host`、同源写请求和自定义 UI 请求头；
- 使用严格 CSP、`frame-ancestors 'none'`、`nosniff` 和 `no-referrer`；
- JSON 输入按 Schema 校验，单次请求体限制为 64 KiB；
- 用户保存的标题、正文、路径和上下文结果都通过 `textContent` 渲染，不作为 HTML 执行。

自动化环境可使用 `node dist/cli.js ui --no-open --port 0`，命令会输出带一次性 fragment 的启动地址。这个地址等同于当前 UI 会话凭据，不应写入共享日志。

## 本地存储与安全

默认存储结构如下：

```text
<storage-root>/
├── registry.db
└── recovery/
    └── <project-id>-<timestamp>.db

<project-root>/
└── .project-context/
    └── project.db
```

`storage-root` 只保存跨项目注册信息、用户级规则和恢复备份。每个项目的索引、项目记忆、候选和任务
检查点固定保存在该项目自己的 `.project-context/project.db`。注册新项目时会自动创建这个目录；
注册表 Schema v3 会在启动时为旧的中央项目数据库创建完整性校验备份，再迁移到对应项目目录。
`.project-context/` 同时被默认索引规则和仓库 `.gitignore` 排除，数据库不会被重新索引或提交。

安全措施包括：

- 项目根目录和备份/导出目录 allowlist；
- symlink-aware 路径校验，防止通过符号链接越权访问；
- 默认排除 `.env`、凭据、私钥、数据库、二进制和大型文件；
- 检测并拒绝疑似包含密钥的长期记忆；
- 不持久化完整 Git diff、完整聊天记录或检测到的密钥值；
- 加密备份只接收环境变量名，不把口令放进 MCP/CLI 参数、数据库或文件头；
- 每份加密备份使用随机 salt 和 IV，通过 scrypt 派生 256 位密钥，并由 AES-GCM 认证完整性；
- 明文备份临时文件在成功和失败路径中都会清理；
- 覆盖恢复前创建内部安全备份，恢复库必须通过 Schema、`quick_check` 和外键检查；
- 永久删除必须先归档、精确确认项目 ID，并清空活跃记忆、进行中任务和待审候选；
- 索引可以重建，长期记忆和任务检查点作为规范数据独立保存。

### 项目生命周期与恢复闭环

项目目录改名或移动不会自动删除记忆。应使用 `project_update` 修改显示名称，使用 `project_relocate` 把登记路径指向新的、已存在且在 allowlist 内的目录。长期不维护的项目使用 `project_archive` 隐藏，数据仍完整保留；需要继续时调用 `project_unarchive`。

`project_delete` 默认只返回删除预览。真正设置 `purge=true` 前必须满足：

- 项目已经归档；
- `confirmProjectId` 与目标 ID 完全一致；
- 活跃项目记忆为 0；
- 进行中任务为 0；
- 待审候选为 0；
- 项目 watcher 已停止；
- 可选最终备份目标位于授权输出目录且尚不存在。

本地目录暂时不可访问不会触发自动删除。永久清除后，项目注册记录和项目数据库目录才会被移除。

普通备份通过 `project_restore` 恢复，加密备份通过 `project_restore_encrypted` 恢复。恢复有两种模式：

| 模式 | 条件 | 行为 |
| --- | --- | --- |
| 恢复为新项目 | 提供新的、已存在且受授权的 `root` | 创建新项目 ID，把旧 Schema 自动迁移到当前版本 |
| 回滚已有项目 | 目标已归档，且精确提供 `projectId` 和 `confirmProjectId` | 先写入 `recovery/` 安全备份，再替换数据库并自动取消归档 |

恢复源必须在输出 allowlist 内。损坏 SQLite、非项目数据库、未来 Schema、外键错误、活动项目覆盖和确认不匹配都会被拒绝。加密文件还必须通过 AES-GCM 认证；口令丢失时无法恢复，这是端到端口令加密的预期性质。

### MCP 托管索引的控制边界

MCP `project_open` 会先完成首次或增量索引，再自动启动当前项目的进程级 watcher，并通过 MCP 进度通知报告大型项目的索引进度。`project_search`、`project_context`、`task_complete` 和 `task_cancel` 会等待并刷新尚未处理的文件变化，避免去抖窗口导致读取旧索引。内部数据库、版本控制元数据、依赖目录和常见构建目录不会触发 watcher。

watcher 只存在于当前 MCP/CLI 进程内，不写入 SQLite；MCP 连接关闭时统一释放。进程重启后，下一次 `project_open` 会重新同步并启动 watcher。CLI 保持显式的 `index` 和 `watch` 行为，MCP 的显式 watch/index 工具也继续用于诊断和手动控制。无论手动还是托管索引，新发现的长期信息都只会成为 `pending` 候选，系统永远不会自动调用 `memory_candidate_accept`。

## 技术栈

| 技术 | 用途 |
| --- | --- |
| Node.js 22+ | 运行环境 |
| TypeScript | 核心开发语言 |
| MCP TypeScript SDK | MCP 工具、资源、Prompt 和 stdio 服务 |
| SQLite / `better-sqlite3` | 项目注册、索引、记忆和任务存储 |
| SQLite WAL / FTS5 | 在线操作与全文检索 |
| Unicode n-gram | 中文和子串检索 |
| Tree-sitter | JavaScript/TypeScript 代码分析 |
| Zod | MCP 输入输出校验 |
| Commander | 命令行接口 |
| Vitest | 单元、集成和 MCP 契约测试 |

## 安装与构建

环境要求：

- Node.js 22 或更高版本；
- npm 10 或更高版本。

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run eval
```

初始化存储：

```powershell
node dist/cli.js init
```

注册并索引项目：

```powershell
node dist/cli.js project open D:\project\my-app
node dist/cli.js index <project-id>
```

搜索并组装任务上下文：

```powershell
node dist/cli.js search <project-id> "refresh token"
node dist/cli.js context <project-id> "继续实现令牌重用检测"
```

## MCP 客户端配置示例

构建项目后，可在 Codex 配置中添加：

```toml
[mcp_servers.project-context]
command = "node"
args = ["D:/project/project-context-mcp/dist/mcp/server.js"]
```

存储需要先通过 CLI 明确初始化。MCP 服务不会在后台静默选择或创建持久化目录。

Claude Code 可以使用用户级 stdio 配置：

```powershell
claude mcp add --scope user project-context -- node D:/project/project-context-mcp/dist/mcp/server.js
claude mcp get project-context
```

Cursor 和其他支持 stdio MCP 的客户端同样使用 `node` 作为命令，并把 `dist/mcp/server.js` 的绝对路径作为参数。

### 推荐的客户端全局会话规则

MCP 负责索引和 watcher 的内部调度，但它不能主动感知客户端何时进入了某个仓库。需要用一段全局规则引导客户端在会话首个任务中调用 `project_open`：

首次安装后的最小配置闭环是：先用 CLI 初始化个人存储与允许的项目根目录，再把 MCP 注册到所用客户端，最后追加下面的客户端全局会话规则。这三项只需配置一次；完成后，每个项目和每次普通开发任务都不需要重复修改提示词或手动调度索引。

- Codex：Windows 编辑 `%USERPROFILE%\.codex\AGENTS.md`，macOS/Linux 编辑 `~/.codex/AGENTS.md`；
- Claude Code：Windows 编辑 `%USERPROFILE%\.claude\CLAUDE.md`，macOS/Linux 编辑 `~/.claude/CLAUDE.md`；
- Cursor 或其他客户端：加入客户端的全局 User Rules；
- 文件已有其他个人规则时，只追加下面的受管区块，不要覆盖原内容；
- 这段启动规则不能只写进某个项目的局部规则或 Project Context 工作台规则，否则新仓库和第一次 MCP 调用无法稳定覆盖。

```markdown
<!-- project-context-mcp:start -->
# Cross-session Project Context (project-context-mcp)

Use project-context-mcp to retain sourced project knowledge across AI coding sessions.

## Session Workflow
1. At the beginning of the first user turn in a repository, call `storage_status`.
2. Call `project_open` with the repository's absolute root path and reuse the returned project ID. The MCP server synchronizes the index and manages change tracking for the current process.
3. Before substantial implementation work, call `project_context` with the current task and `budgetTokens: 3000`; increase the budget explicitly only when the task needs a larger snapshot.
4. Use `project_search` for indexed text, symbols, memories, and code relationships instead of guessing. Managed pending changes are flushed before reads.
5. For non-trivial work, call `task_start`, save progress with `task_checkpoint`, and call `task_complete` when finished. Completion flushes pending project changes.

## Memory Rules
- Review `memory_candidates` after indexing Git changes. Accept or reject candidates explicitly; never accept them automatically.
- Use `memory_remember` only for durable decisions, constraints, lessons, or facts with a clear source.
- Never store credentials, private keys, tokens, full chat transcripts, or full Git diffs.
- Run `project_doctor` when stored context appears incomplete or inconsistent.
<!-- project-context-mcp:end -->
```

这段配置只负责触发会话工作流，不要求 Codex 判断“短任务还是长任务”后再决定是否启动 watcher。只要调用 `project_open`，MCP 就会完成索引并启动当前进程内的托管监听；进程结束后监听随之释放，下次会话再次打开项目时自动恢复。

## 适用场景

Project Context MCP 适合：

- 需要跨多次 AI 会话持续开发的项目；
- 拥有较多架构决策、约束和历史背景的代码库；
- 同时使用 Codex、Claude Code、Cursor 等多个 MCP 客户端；
- 希望项目知识保留在本机，不依赖远程记忆服务的团队或个人；
- 需要对 AI 长期记忆进行审核、追溯和生命周期管理的工程流程。

## 当前边界

当前版本聚焦本地、可审查、可恢复的项目知识管理。以下能力仍然处于延后状态：

- LSP 集成；
- embedding 向量检索；
- 远程存储；
- 团队实时同步。

这些边界使当前实现能够保持本地依赖少、数据路径清晰、行为可测试，同时为后续扩展保留空间。

## 总结

Project Context MCP 将项目索引、代码关系、长期记忆、任务续接、上下文组装和数据维护整合为一套本地工具链。它不是用聊天记录代替项目知识，而是把重要信息转化为有来源、可审核、可搜索、可持续维护的工程上下文，让 AI 编程助手在长期开发中保持连续性。
