# 自托管团队服务

团队端采用可信服务端模型：管理员部署的服务能读取共享记忆，统一执行权限、搜索、审核与审计。项目数据库和 team.db 在服务端是普通 SQLite 文件；磁盘加密、目录访问控制、备份和 TLS 由部署方配置。对象存储中的知识备份/同步批次仍使用 AES-256-GCM。本功能不是端到端加密的团队搜索。

## 初始化与连接

先完成本地 init、project open/index。以下命令由有权访问服务端存储的本地管理员执行。替换占位符；输出文件须位于 allowedOutputRoots，且不能已存在。

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

团队冲突审核复用 P1 因果事件日志：项目先配置单用户同步，出现并发版本后，由授权审核者在 Web 或 MCP 选择版本。只展示该共享类型范围内的 memory 冲突。首版提供“择一”而非文本编辑合并；选择后生成引用全部冲突头的新事件，旧版本保留。团队共同使用一个服务端项目数据库，不在每台客户端自动建立项目副本。P1 对象存储共同凭据不是团队 ACL，不应向不可信成员发放该凭据。

team_audit_export 按 shareId 返回每页最多 1000 条记录，以 offset=0、1000……读取，直到空页。记录包含认证用户、客户端、操作类型、实体 ID、时间、结果；不记录原始令牌。审计和项目内容分库，跨库写入不保证原子性：开始时写 started，成功或失败后更新 completed/failed；进程异常退出可留下 started，需要运维核对。被权限检查拒绝的请求不会写成成功审计；当前没有防管理员篡改的外部审计存储。

presence 是协作提示：任务存在才可声明，TTL 最多 300 秒，客户端定期续约，TTL=0 释放。过期记录不显示，不提供排他锁；任务取消/完成并不立即删除提示，最多等待 TTL 结束。

## 可选代码图谱

```powershell
node dist/cli.js team code-sharing <share-id> --actor alice --enabled true
```

显式开启后，成员可通过 team_code_graph 或审核页“导出只读代码关系图（JSON）”下载。输出最多 5000 个符号、10000 条已解析关系，包含相对路径、名称、类型和行号；排除源码全文、签名、调用证据、绝对根路径。结构名称和路径仍属于项目资料。manifest 标记版本、索引时间、捕获的版本控制 revision、是否截断；图谱不是可导入的搜索索引，也不保证当前工作区仍与捕获 revision 一致。--enabled false 后禁止新的导出。

服务状态保存在 <storage-root>/team.db，另有 registry.db 和各 project.db。灾备时应协调停止写入并备份这些文件；P0 知识包只迁移项目知识，不包含团队成员、令牌摘要、ACL 和审计。对象存储访问密钥可独立轮换；加密口令变更不会重加密旧对象，旧备份仍需旧口令。单用户同步换口令时应新建空间/前缀并以知识快照重新初始化，不能用新口令继续读取原空间。
