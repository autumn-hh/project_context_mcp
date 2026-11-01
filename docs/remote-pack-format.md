# 知识快照包 v1（P0-1）

包是单文件二进制容器：ASCII `PCMPACK1\n`（9 字节）、4 字节大端 manifest 长度、UTF-8 manifest JSON、按 manifest 顺序连续存储的 JSONL 分片。无归档解压或包内文件路径；不允许尾随字节。

manifest 分离 `version`（容器协议）与 `schemaVersion`（来源项目数据库）；每片包含允许的实体名、记录数、字节数和 SHA-256。摘要检测意外损坏，不表示可信来源；远程传输必须外包 AES-GCM，并认证 manifest。

知识包不包含 chunks、FTS、symbols、relations、运行日志或用户机器配置。记忆/候选正文和任务记录可能包含用户主动保存的代码及路径；来源 source_excerpt 默认置空但保留来源 hash，显式选择时可纳入摘录。不得宣称包自动清除了全部敏感内容。

允许表：memories、memory_knowledge、memory_sources、memory_candidates、tasks、task_events、task_checkpoint_requests、user_memories。memory_knowledge 保留实体、别名、关系、原记忆哈希、连续记忆引文和审核状态；这些引文来自已存储记忆，不是代码索引摘录。字段严格验证；memory_sources.source_id 置空，目标机重新索引时建立本地来源。记录 ID、状态、时间、supersede、任务快照和回执保持；项目身份仅表示来源，恢复为新本地项目时重新映射。

用户规则只导出显式选中的规则及其 supersede 前驱；不自动包含全部 registry。非当前项目的规则拒绝。全局/工作区规则需要明确选择并在恢复时指定对应范围，禁止把原工作区绝对路径直接当作新工作区。来源项目与规则分别在读事务内取快照，不承诺两库全局原子快照。

0.12.0 支持 schema 10 和不含 memory_knowledge 的 schema 9 旧包。新表在 memories 之后恢复；不允许将包含实体整理的包伪装成 schema 9。旧客户端不能读取 schema 10 包，需先升级。manifest 最大 1 MiB，单片最大 16 MiB，单记录最大 8 MiB，总包最大 1 GiB，最大 16384 片。超限返回结构化错误，避免不受限内存或磁盘消耗。分片顺序/表顺序固定，允许空表。

恢复先完整校验并写入全新临时数据库；任何版本/类型/引用/摘要失败不得触及现有项目。最终发布使用不覆盖已有文件的方式。包包含的 rules 先独立恢复到隔离规则数据库，由应用层按明确映射导入 registry；不能静默注入个人规则。

P1 增量包将使用独立 kind/version 契约，定义 device/event/causal revision；快照 task_events.sequence 仅保留单个来源数据库的历史顺序，不作为跨设备顺序。
