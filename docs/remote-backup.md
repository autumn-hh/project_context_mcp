# 加密远程知识备份（P0）

本版本提供知识快照、加密、S3 兼容对象存储、CLI/MCP 与工作台入口。它用于灾备和人工多机迁移；增量同步、团队权限和检索扩展见对应的 P1–P3 操作文档。

## 内容与兼容

默认包含项目记忆、候选、来源证据（不含摘录）、任务、历史和请求回执。代码索引、源码文件、全局机器配置与个人规则不会自动进入包。记忆/任务正文中主动保存的代码或路径仍会包含。可显式选择个人规则；其 supersede 前驱一起导出。既有 `backup`、`backup-encrypted` 与 `.pcmb` 整库备份继续工作。

知识包 `.pcmp` 是明文，仅用于本地导出/检查；远程入口始终先使用 scrypt + AES-256-GCM 加密整个包，manifest 在密文内。口令与存储凭据仅从指定环境变量读取。丢失口令无法恢复。

## 配置与使用

使用你自己的私有 S3 兼容存储，在运行 CLI/MCP/Web 的进程环境设置凭据与备份口令。不要把值粘贴进项目文件、命令参数或聊天。然后配置引用：

```powershell
node dist/cli.js remote add personal --endpoint https://s3.example.com --region us-east-1 --bucket my-private-bucket --access-key-env MY_S3_ACCESS --secret-key-env MY_S3_SECRET --passphrase-env MY_BACKUP_PASSWORD
node dist/cli.js remote show personal
node dist/cli.js backup push-remote <project-id> --remote personal
node dist/cli.js remote history <project-id>
node dist/cli.js backup pull-remote <object-key> D:\Backups\staged-new --remote personal
```

当前是 path-style S3、AWS Signature V4、HTTPS origin 端点，不接受 URL 内凭据、路径、查询和重定向。自托管本机测试可显式添加 `--allow-loopback-http`，仅接受 `127.0.0.1` 或 `[::1]`。远程目标配置保存在存储根的 `remote-targets`，不进入项目知识包；同名配置不覆盖，修改目标时使用新名称。

上传使用随机不可变对象键和 `If-None-Match: *`。最多三次内部尝试；响应丢失后检查远端长度和 SHA-256 元数据。所有下载有大小限制，校验后才发布目标文件，再执行 AES-GCM 认证和包校验。单次 HTTP 请求超时为 30 秒；超大包或慢网络可能失败，当前没有 multipart/resume。每次重新调用备份创建新版本；刷新本机历史可确认已收到成功响应的备份。

备份返回的 `remoteName`、`key` 应独立保留；本机历史损坏/丢失不删除远端对象。当前不列举远端 bucket，也不自动清理远端备份。若上传成功但本机记录失败，返回 `historySaved: false` 与对象键。

## 恢复与规则映射

下载恢复只允许全新的授权输出目录，得到 `project.db` 和 `rules.db`。不会替换已有文件、登记项目或自动应用规则。先准备 Git 源码目录，再登记：

```powershell
node dist/cli.js project restore D:\Backups\staged-new\project.db --root D:\project\restored-app
node dist/cli.js index <new-project-id>
node dist/cli.js pack import-rules <new-project-id> D:\Backups\staged-new\rules.db
node dist/cli.js pack import-rules <new-project-id> D:\Backups\staged-new\rules.db --apply
```

`import-rules` 默认预览。全局规则要求 `--allow-global`；工作区规则要求 `--workspace-root <absolute-path>`。项目/模块/任务规则映射到目标项目，任务规则必须引用已恢复任务。导入 ID 稳定映射，重复导入幂等；本地修改过的已导入规则报冲突，不覆盖。导入按 registry 事务完成，与项目恢复是两个显式步骤。

默认规则不上传；选择规则使用 `backup push-remote ... --user-memory <id...>`，包含来源摘录使用 `--include-source-excerpts`。包格式、大小与版本限制见 [格式规范](remote-pack-format.md)。来源路径重建后按 hash 检查漂移；被排除的来源摘录不能用于段落级匹配，文件整体改变时判断更保守。

## MCP 与工作台

- `project_backup_remote(projectId, remoteName, userMemoryIds?, includeSourceExcerpts?)` 返回对象键、摘要和本地记录状态。
- `project_restore_remote(remoteName, key, directory)` 下载认证并暂存到新目录，返回 `rulesApplied: false`。
- 工作台 → 项目画像 → 远程备份：已配置目标、最近成功时间、最近 50 条本机成功记录、选择备份恢复；上传前显示范围确认。配置仍通过 CLI 完成。

本地打包/校验使用同步 SQLite 与有界分片 I/O，大包可能短暂占用本地服务事件循环；当前没有独立后台迁移任务。浏览器断开不等同操作回滚，应先刷新记录。

## 验证范围

已用隔离对象存储模拟服务校验 AWS V4 签名，跑通 CLI/MCP/Web 上传、下载、认证、恢复；覆盖响应丢失、不可覆盖、损坏/超限包与规则作用域。浏览器检查桌面、390px、展开记录及 CSS 200% 放大；没有金额卡片、可隐藏表格列，相关验收不适用。2026-10-27 追加云 VM 上自托管 MinIO 的 18 项真实网络验收，容器重启后备份摘要一致。覆盖范围与保留服务连接方式见 [云端验收记录](cloud-s3-acceptance.md)；AWS/OSS 托管服务和公网 HTTPS 尚未验证，换目标后应重新做隔离恢复演练。
