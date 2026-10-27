# 云服务器 S3 验收与保留服务

2026-10-27 已在云虚拟机上的自托管 MinIO 完成真实网络验收。客户端为 Windows/Node.js 22，通过 SSH 隧道连接服务器回环端口；使用两个独立本地存储目录模拟设备，仅上传随机命名空间中的合成数据。首次验收版本为 0.10.0，0.10.1 收录验收脚本、结果和运维指引，应用运行逻辑不变。

## 验收结果

18 项集成断言通过，另行重启 MinIO 后重新下载同一对象，SHA-256 一致。0.10.1 使用仓库脚本复跑，18 项与重启检查再次通过（2026-10-27 06:21–06:22 UTC）。每次运行写入 6 个对象，备份包为 3,471 字节；这不是容量或吞吐基准。

| 检查范围 | 实际结果 |
| --- | --- |
| 加密备份、成功回执、远端密文摘要、无明文哨兵 | 通过 |
| 下载、解密、恢复记忆和任务历史、登记后搜索 | 通过 |
| 相同对象重复 PUT、不同内容覆盖拒绝、已有本地文件保护 | 通过 |
| 错误口令拒绝且不留下恢复目录 | 通过 |
| 错误签名、越界前缀写入、匿名读取、DELETE | 全部被服务器拒绝 |
| 双独立设备交换记忆和任务历史、重复拉取幂等 | 通过 |
| 并发删除冲突、人工择一、另一端收敛 | 通过 |
| 无效凭据导致推送失败后保留队列，恢复凭据重试 | 通过 |
| ListObjectsV2 范围过滤、本地应用重启后保留回执 | 通过 |
| MinIO 容器重启后对象与受限用户仍可用 | 通过 |

已核对容器资源、回环绑定、非 root 用户、只读根目录和凭据权限；没有 OOM 或自动重启。验收后瞬时内存约 60 MiB。原有四个业务容器仍运行，启动时间均早于本次部署；没有修改其容器、Nginx、防火墙或 Docker daemon 配置。

覆盖边界：本次是云 VM 上的 MinIO，未验证 AWS S3、阿里云 OSS 等托管服务，也未验证公网 HTTPS、生产 TLS 代理、长期大容量运行、负载或主机重启。失败队列测试使用错误凭据；真正网络断连和响应丢失由本地隔离测试覆盖。团队 HTTP MCP、OIDC、第三方模型不属于这次对象存储部署。

## 保留的服务

用户授权验收后保留；服务器地址由部署方管理，不写入公共仓库。

| 项目 | 配置 |
| --- | --- |
| 容器 | `project-context-minio` |
| 服务器监听 | `127.0.0.1:19000` → 容器 9000 |
| 资源 | 1 CPU、512 MiB 内存、内存加交换空间总限额 512 MiB、256 PID |
| 运行身份 | UID/GID 10001，移除 capabilities，no-new-privileges，只读根目录 |
| 启动策略 | `unless-stopped` |
| Bucket / region | `project-context-acceptance` / `us-east-1` |
| 数据 | `/opt/project-context-minio/data` |
| 凭据 | `/opt/project-context-minio/credentials.json`，root:root / 0600；父目录 0700 |
| 部署与构建来源 | 同目录的 `deployment.json`、`build/provenance.json` |
| 日志轮转 | 10 MiB × 3 |

管理账号与客户端账号分离。客户端只可列举和读写 `acceptance/*`、`backups/*`、`sync/*`；不能删除对象，bucket 私有。不可变性由客户端的条件 PUT 保证；此策略不是 S3 Object Lock，也不阻止持有写权限的人绕过客户端直接覆盖对象。单个 bucket 凭据不构成团队成员 ACL，不应发给不可信成员。

由于镜像仓库无法取得镜像，使用官方固定标签源码在本机交叉编译，再打包为 scratch 镜像；不是官方预编译镜像。Go 1.26.3，GOOS=linux，GOARCH=amd64，CGO_ENABLED=0，`go build -p 2 -trimpath -ldflags="-s -w"`。未写发布版 ldflags，二进制自身可能显示开发构建版本，应以以下来源和摘要核对：

- MinIO：`RELEASE.2025-10-15T17-29-55Z`，提交 `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`；二进制 SHA-256：`2dca6a3481e9cb29c54d91de07b2c4b8371a2a98197cd263a87121f5df31264f`。
- mc：`RELEASE.2025-08-13T08-35-41Z`；二进制 SHA-256：`c05904b815c97d5268de3625fd3c4909869e3ab3206247f85aaaeba3940a865f`。
- 部署镜像 ID：`sha256:5014a4300181154ef8594e0e91266087e4c3fc9f8cde4f8fa14e44e02b0f3a3c`。
- 原始源码归档（含许可证）和摘要保留在服务器 `build/`；应用分发包不携带 MinIO 或 mc 二进制。后续升级需重新验证。

## 后续连接

本地终端保持 SSH 隧道运行，将 `<server>` 换成实际服务器：

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:19000:127.0.0.1:19000 root@<server>
```

通过受保护的 SSH/SFTP 取用凭据，映射 `accessKey`、`secretKey`、`passphrase` 到客户端进程环境变量 `PCM_CLOUD_ACCESS`、`PCM_CLOUD_SECRET`、`PCM_CLOUD_PASSPHRASE`。不要输出整个文件或提交其内容。将备份口令另存于受控密码管理器；服务器丢失时，仅有密文无法恢复。管理员字段不能用于普通客户端。

```sh
node dist/cli.js remote add cloud-vm --endpoint http://127.0.0.1:19000 --region us-east-1 --bucket project-context-acceptance --prefix backups/personal --access-key-env PCM_CLOUD_ACCESS --secret-key-env PCM_CLOUD_SECRET --passphrase-env PCM_CLOUD_PASSPHRASE --allow-loopback-http
node dist/cli.js backup push-remote <project-id> --remote cloud-vm
node dist/cli.js remote history <project-id>
```

`--prefix` 必须在授权范围内；默认 `project-context` 前缀没有权限。两台设备使用同一目标前缀、口令和 syncId，分别绑定自己的本地项目；具体见 [同步操作](sync-protocol.md)。这是一条可选连接方式，不会自动将本机项目上传。

服务器上可执行以下管理命令；重启会短暂中断这一存储服务：

```sh
docker ps --filter name=project-context-minio
docker stats --no-stream project-context-minio
curl --fail http://127.0.0.1:19000/minio/health/ready
docker restart project-context-minio
```

单机单磁盘不是高可用集群。后续使用需要监测磁盘空间，并为数据和凭据安排受保护的独立备份；本次没有设置自动删除策略或改动既有服务器备份。

## 复跑验收

源码仓库提供显式执行的脚本，不放入默认 `npm test`，以免普通测试访问外部服务。先准备上述限制策略、环境变量和 SSH 隧道；设置 `PCM_CLOUD_ENDPOINT=http://127.0.0.1:19000`。可选 `PCM_CLOUD_BUCKET`、`PCM_CLOUD_REGION` 覆盖默认值。

```sh
npm run build
node scripts/cloud-acceptance.mjs
# 在服务器执行 docker restart project-context-minio 并确认健康后：
node scripts/cloud-persistence.mjs
```

每次创建 `acceptance/run-<uuid>` 合成对象；不删除远端对象，验证失败时也可能留下部分测试数据。使用专用受限账号，不能使用管理员账号，否则拒绝删除/越界写入的验收条件不成立。结果与重启校验信息写入忽略目录 `output/cloud-acceptance/`，可用 `PCM_CLOUD_OUTPUT` 指定目录；结果可能包含本机临时目录路径，分享前应去除。输出不记录凭据，失败返回非零退出码。
