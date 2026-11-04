# 自托管团队服务

## 服务器是共享知识中心，开发在各自本机

多个客户端连接同一个团队 MCP、使用同一个 shareId，就直接读写同一份服务端数据。无需共享 SQLite 文件夹，也无需先运行 S3 推送/拉取。

| 内容 | 保存位置 | 使用入口 |
| --- | --- | --- |
| 团队记忆、共同决策 | 团队服务器 | team_search / team_propose / team_candidate_accept |
| 团队计划、进度与历史 | 团队服务器 | team_task_start / team_task_checkpoint / team_task_list / team_task_history |
| 团队项目规则与版本 | 团队服务器 | team_rule_put / team_rule_list / team_rule_history |
| 成员、权限与审计 | 团队服务器 | 管理员 CLI / team_audit_export |
| 源码、代码索引、个人规则、私人任务 | 每个开发者本机 | 本地 stdio MCP 与本机工作台 |

推荐在 IDE 中配置两个名称明确的 MCP：本地 project-context-local 用于项目代码与个人上下文；远程 project-context-team 用于共享知识。仅修改 Web 的连接方式不会自动改写 IDE 的 MCP 配置。远程使用 Streamable HTTP、MCP URL 和客户端秘密配置提供的 Bearer 请求头；不要把令牌写进项目文件。服务器可用空目录登记知识项目，不要求上传 Git 仓库。各开发机的目录可以不同。

给开发代理的工作约定可以写为：

> 开始任务先从 project-context-team 调用 team_projects，选定共享项目后用 team_context 读取团队记忆、计划和规则；通过 project-context-local 读取本地代码与个人上下文。需要协作的计划使用 team_task_start，进度使用 team_task_checkpoint。稳定结论通过 team_propose 提交审核。仅明确共享的内容写入团队服务，不上传源码、密钥或个人偏好。

这是一项调用约定，连接 MCP 本身不会强制所有 AI 自动读取或遵守规则。服务器离线时本机开发仍可继续；团队读写会报错，不会偷偷写入本地副本。

## 共享计划与规则

team_context 返回最多 20 条共享记忆、20 个进行中的计划及 50 条有效规则。计划与规则可用对应 list 工具的 limit/offset 分页；计划支持 in_progress/completed/cancelled 筛选，规则支持 active/deleted。team_task_get 返回当前版本，team_task_history 和 team_rule_history 保留历史。记忆检索可用 team_search 的 query 缩小范围。

创建计划后，将返回的 id 和 version 传给 team_task_checkpoint：

```json
{
  "shareId": "<shared-project-id>",
  "taskId": "<task-id>",
  "expectedVersion": 1,
  "requestId": "client-checkpoint-001",
  "checkpoint": {
    "summary": "已完成本地接口，等待另一位成员联调",
    "completed": ["本机类型检查通过"],
    "next": ["联调共享计划读取"]
  }
}
```

checkpoint 是本次完整进度快照；未提供的列表会清空。更新时须使用最新 version；并发修改返回 TEAM_VERSION_CONFLICT，先重新读取并合并。相同 requestId 仅用于同一客户端重试同样的 task/checkpoint，重试不会覆盖后来的进度。team_task_finish 以最新版本完成或取消任务。既有私人任务不会自动出现在共享列表，每个 shareId 的任务独立。

owner/reviewer 可调用 team_rule_put 新建规则；编辑时带 ruleId 和 expectedVersion。team_rule_disable 停用并保留历史，重新 put 同一个 ruleId 可恢复。editor 可以更新计划，但不能改团队规则；viewer 只读。规则是共享项目规则，不修改任何开发者的个人规则。

团队端采用可信服务端模型：管理员部署的服务能读取共享记忆，统一执行权限、搜索、审核与审计。项目数据库和 team.db 在服务端是普通 SQLite 文件；磁盘加密、目录访问控制、备份和 TLS 由部署方配置。对象存储中的知识备份/同步批次仍使用 AES-256-GCM。本功能不是端到端加密的团队搜索。

## 初始化与连接

先完成服务端 init、project open；知识项目不需要源码索引。以下命令由有权访问服务端存储的本地管理员执行。替换占位符；输出文件须位于 allowedOutputRoots，且不能已存在。

```powershell
node dist/cli.js team init --org Engineering --workspace Backend --owner alice
node dist/cli.js team invite <workspace-id> bob --actor alice --role reviewer --output D:/protected/bob-invite.txt
node dist/cli.js team accept-invite D:/protected/bob-invite.txt
node dist/cli.js team token bob --client cursor-bob --output D:/protected/bob-token.txt
node dist/cli.js team share <workspace-id> <project-id> --actor alice
node dist/cli.js team serve --port 8787
```

邀请一次有效、一天过期；成员名由管理员指定。CLI 接受邀请是一项本地管理操作，没有公开注册接口。令牌默认有效 30 天，服务端只保存 SHA-256 摘要。令牌文件包含唯一明文副本，妥善保管；POSIX 创建权限为 0600，Windows 应检查目录和文件 ACL。客户端使用 Streamable HTTP MCP 地址 http://127.0.0.1:8787/mcp，并由客户端的秘密配置提供 Authorization: Bearer <token>，不要把值提交到仓库。

每个客户端分别签发令牌。轮换时先签发新令牌、更新客户端，再执行 team revoke-token <old-token-id>。team member <workspace-id> bob --actor alice --role removed 移除成员；--role editor/reviewer/viewer/owner 可改角色，最后一个 owner 不允许降级或移除。撤销共享使用 team revoke-share <share-id> --actor alice。撤销作用于后续请求，不撤回用户已经下载的内容。

HTTP 服务只绑定 127.0.0.1，拒绝浏览器 Origin，接受 POST /mcp；请求体上限 128 KiB。对外部署须使用受信任的 TLS 反向代理，将 Host 改写为 127.0.0.1:8787，并转发 Authorization、Accept 和 MCP-Protocol-Version。不要记录 Authorization。按客户端需要配置请求速率和并发限制。当前支持 Bearer，未实现 OIDC/OAuth 登录或自动令牌发现。真实生产代理和公网部署尚未验收。

## 可选：本机工作台连接远程 MCP

Web 的代码、个人规则和原有任务页面使用本机数据。顶部独立的「团队知识」入口可显式连接另一台已部署的团队 HTTP MCP，直接管理共享记忆、计划和规则：

```powershell
node dist/cli.js connection show
node dist/cli.js connection use-remote --url http://192.168.1.10:8787/mcp
# 公网须 https，例如：
# node dist/cli.js connection use-remote --url https://team.example.com/mcp --token-env PROJECT_CONTEXT_TEAM_TOKEN
# 启动 UI 前，从自己的秘密存储向进程环境注入 PROJECT_CONTEXT_TEAM_TOKEN。
node dist/cli.js connection use-local
```

也可在 Web「团队知识 → 团队知识连接」里切换。本机没有登记代码项目时也能使用团队入口；共享项目独立选择。页面和编辑弹窗显示数据来源及写入目标。令牌只放在服务进程环境变量，不进连接配置文件、不进浏览器。本地 UI 只监听 127.0.0.1。切换连接会清空旧内容；旧连接发起的写入请求被拒绝，须刷新后继续。

网页操作：

- 共享记忆：搜索、提议、按原审核策略接受候选；默认允许决策和约束，其他类型由管理员配置。记忆搜索最多100条，使用关键词缩小范围。
- 共享计划：创建，编辑进度说明/已完成/下一步/阻塞/风险，完成或取消；按状态筛选，每页20条，历史可翻页。修改文件与验证记录保留已有值。
- 项目规则：创建、编辑、停用、从已停用列表编辑恢复；按状态筛选，查看分页版本历史。
- owner/reviewer 可管理规则，editor 可更新计划和提议记忆，viewer 仅查看；页面按钮与服务端权限一致。

并发编辑返回版本冲突时保留当前弹窗草稿。点击“读取最新版本”核对服务器内容，再按需修改草稿，点击“已核对，以最新版本提交草稿”后再次保存。不会自动覆盖其他成员更新。计划已结束时不能继续更新进度。进度相同内容重试使用同一请求ID；新建操作断网时应先刷新列表核对是否成功，避免重复创建。草稿仅在当前页面内存，关闭弹窗或刷新页面不保留。

「项目画像 → 备份与同步」继续操作选中的本机项目，用于个人备份和多机同步；其中提供跳转团队入口。它不会备份整个团队服务，也不是团队共享知识的推送入口。


例如 Nginx 的 location 配置（TLS 证书及 server_name 另行配置）：

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:8787/mcp;
    proxy_set_header Host 127.0.0.1:8787;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    client_max_body_size 128k;
}
```

## 权限和共享范围

| 角色 | 搜索/图谱/presence 读取 | 提议候选/声明任务 | 接受候选 | 解决冲突/读审计 | 管理成员/共享 |
| --- | --- | --- | --- | --- | --- |
| viewer | 是 | 否 | 否 | 否 | 否 |
| editor | 是 | 是 | 仅关闭 reviewer 要求时 | 否 | 否 |
| reviewer | 是 | 是 | 是 | 是 | 否 |
| owner | 是 | 是 | 是 | 是 | 是 |

HTTP 按认证身份提供工具子集，每次操作重新检查实际 workspace/share 权限。多工作区成员看到的工具列表可能包含其他工作区允许的操作，调用时仍按所传 shareId 检查。客户端不能通过参数指定 actor。

默认共享 decision、constraint；preference、其他类型、个人规则和源码索引不自动共享。team share 的 --types 可明确调整类型，--allow-editor-review 可允许 editor 接受候选。团队搜索仅查询 active 状态且类型被共享的项目记忆，不使用本机任意文件/代码搜索工具。共享按整个项目和记忆类型划分，没有更细的目录/单条记忆 ACL；共享包含相同类型的本地候选，审核前应核对内容。

本地管理员信任边界高于团队 ACL：能访问存储目录、CLI 或完整本地工作台的人能直接管理项目。不要将本地 UI 作为面向不可信团队成员的门户公开。成员通过受限的 HTTP MCP 连接；本地审核页通过服务进程环境 PROJECT_CONTEXT_TEAM_UI_TOKEN 绑定一个团队身份，不向浏览器传递团队令牌。

## 工具、冲突和审计

所有成员可用 team_projects、team_search、team_presence_list、team_code_graph。写入角色另有 team_candidate_list、team_propose、team_candidate_accept、team_presence；owner/reviewer 另有 team_conflict_list、team_conflict_resolve、team_audit_export。

共享知识新增 11 个工具：所有成员可用 team_context、team_task_list/get/history、team_rule_list/history；owner/reviewer/editor 可用 team_task_start/checkpoint/finish；owner/reviewer 可用 team_rule_put/disable。单一 reviewer/owner 工作区共 22 个工具，viewer 共 10 个。本地 stdio 的 53 个工具保持独立，不向团队成员开放服务端文件管理和索引入口。

团队检查点支持工作阶段、等待原因和验收条件；省略字段保留现值，传入数组替换对应字段。完成任务须有最终结论、通过证据、无必要下一步或阻塞，且各验证命令最新结果通过；取消不要求验收。继续使用 `expectedVersion` 做并发检查。团队 HTTP 尚无重新打开任务工具，本地 `task_reopen` 不是团队接口。详细示例和边界见[任务工作流](task-workflow.md)。

团队冲突审核复用 P1 因果事件日志：项目先配置单用户同步，出现并发版本后，由授权审核者在 Web 或 MCP 选择版本。只展示该共享类型范围内的 memory 冲突。首版提供“择一”而非文本编辑合并；选择后生成引用全部冲突头的新事件，旧版本保留。团队共同使用一个服务端项目数据库，不在每台客户端自动建立项目副本。P1 对象存储共同凭据不是团队 ACL，不应向不可信成员发放该凭据。

team_audit_export 按 shareId 返回每页最多 1000 条记录，以 offset=0、1000……读取，直到空页。记录包含认证用户、客户端、操作类型、实体 ID、时间、结果；不记录原始令牌。审计和项目内容分库，跨库写入不保证原子性：开始时写 started，成功或失败后更新 completed/failed；进程异常退出可留下 started，需要运维核对。被权限检查拒绝的请求不会写成成功审计；当前没有防管理员篡改的外部审计存储。

presence 是协作提示：任务存在才可声明，TTL 最多 300 秒，客户端定期续约，TTL=0 释放。过期记录不显示，不提供排他锁；任务取消/完成并不立即删除提示，最多等待 TTL 结束。

## 可选代码图谱

```powershell
node dist/cli.js team code-sharing <share-id> --actor alice --enabled true
```

显式开启后，成员可通过 team_code_graph 或审核页“导出只读代码关系图（JSON）”下载。输出最多 5000 个符号、10000 条已解析关系，包含相对路径、名称、类型和行号；排除源码全文、签名、调用证据、绝对根路径。结构名称和路径仍属于项目资料。manifest 标记版本、索引时间、捕获的版本控制 revision、是否截断；图谱不是可导入的搜索索引，也不保证当前工作区仍与捕获 revision 一致。--enabled false 后禁止新的导出。

服务状态保存在 <storage-root>/team.db，另有 registry.db 和各 project.db。灾备时应协调停止写入并备份这些文件；团队规则/版本在 team.db，计划与共享映射在 project.db。P0 知识包不包含团队规则、共享映射、成员、令牌摘要、ACL 和审计，不能作为完整团队服务备份。对象存储访问密钥可独立轮换；加密口令变更不会重加密旧对象，旧备份仍需旧口令。单用户同步换口令时应新建空间/前缀并以知识快照重新初始化，不能用新口令继续读取原空间。

## 0.10.2 验收范围

已通过本地两客户端 HTTP 集成测试及云 VM 实际部署验收：共享记忆、计划与规则立即可读，任务旧版本修改被拒绝，重启后记录保留，原有记忆仍可检索。云端两个客户端分别认证；没有迁移开发者源码。Web 实际查看云端数据，验证本机/远程切换、展开详情、390px 窄屏与 200% CSS 放大下长标题/连续编号。真实连接使用 SSH 隧道转发至回环监听端口；不代表公网 TLS、OIDC、长期负载或原生系统缩放已经验收。
