# 第一批执行记录：R01 / R02 / T01 / T02

## 当前阅读说明（2026-11-04）

下文按当时验收时间保留历史记录，其中“未提交”“尚未整理”指对应阶段，不是当前状态。后续已完成一轮本机存量标注（37 条记录 / 34 个唯一任务），原证据与历史保留；重复项目仍待核对，不自动双向合并，服务器任务尚未同步。本机数据及验收截图在 Git 忽略的 output 目录，不随仓库发布。通用用法以[任务工作流](task-workflow.md)为准。

随后修复了任务筛选隐藏整个工作区造成的白屏与焦点丢失。相关 16 项测试通过；隔离浏览器覆盖延迟、乱序、失败重试、分页、搜索、项目切换和历史，检查桌面、390px 及 200% CSS 放大。此次推送前补齐工具和文档说明，详细变更见 [Patch Notes](../PATCH_NOTES.md)。

## 范围与基线

本批只处理审计基线、已复现的记忆漏召回、任务工作阶段和完成校验。D01/D02/M01/U01 尚未执行；没有批量修改旧任务、合并项目或删除历史。已有未跟踪文件 _restart_ui.py 保留。

2026-11-03 08:31（Asia/Shanghai）读取 32 个已登记项目。每项目独立快照，不是跨项目全局事务；原有 35 个唯一未完成任务，加上本轮任务为 36 个。

- 本机审计目录：output/audit-20261103-first-batch/（Git 忽略）。
- manifest.json 保存逐项目时间、状态统计、唯一任务计数、最近索引状态、知识包 SHA-256 与恢复结果。首轮统计读取原库，不能保证与包严格一致；下述复查修正后的基线替代首轮统计口径，原包仍保留。
- 每项目知识包保留记忆、来源摘录、候选、任务、历史和幂等请求回执；注册表单独 SQLite 在线备份，包含个人规则。全部保留在本机。
- 32 个知识包均恢复到独立目录，表计数、quick_check、外键检查通过；注册表副本可独立打开。知识包不备份代码索引，恢复后需重建代码索引。
- 比特问题所在 被审计项目 另有完整 SQLite 在线备份：<snapshot.db>。
- 被审计项目 的 doctor 通过，FTS 计数一致，无须重建或删除记忆。当前仓库 89 条历史失败索引最新发生于 11 月 1 日，随后已有成功索引；不能据此认定当前索引损坏。

重新执行审计（目标目录必须不存在）：

~~~powershell
npx tsx scripts/audit-baseline.ts output/audit-new-run
~~~

恢复演练使用现有 restoreKnowledgePack，保留隔离恢复目录供复核，没有覆盖任何已登记项目。实际恢复到工作项目时可复用现有知识包恢复/项目导入流程；完整 SQLite 备份仍支持现有 project_restore。

## R02：证据与修复

期望记录：<expected-memory-id>，位于 被审计项目，来源 task:<source-task-id>。原始返回结果在 recall-before.json，修改后在 recall-after.json。

| 问法 | 原搜索前五条 | 修复后 | 上下文 |
| --- | --- | --- | --- |
| 比特 | 最终结论第 1 | 第 1 | 原先被作用域排除，现命中 |
| NO_PROXY | 只有 OpenCode 代理记忆 | 最终结论第 1 | 命中 |
| 比特内核 400 最后如何通过 NO_PROXY 解决 | 模型测试 HTML | 最终结论第 1 | 命中 |

确认的原因：

1. 中英文相邻时，原词项提取把技术标识符与汉字连在一起；原 n-gram 会跳过这种混合 token，unicode61 也不能按预期独立命中。查询词提取现分开 Han 与 Latin/数字，同时保留其他语言行为。既有索引通过有界技术词候选回退兼容，无需全库重建。
2. 混合搜索把负 BM25 的强命中转成更低分。现修正方向，并复用已有独立记忆召回通道进行融合，避免长问句中 400 的代码片段挤出最终结论。没有比特名称或域名硬编码。
3. 原作用域匹配拆散 NO_PROXY；外部应用的 external-local-app: 标注也按源码路径逻辑处理。现保留完整标识符。复查已收紧应用范围：须命中应用名称、与应用名一致的已审核实体别名，或标题开头紧邻相同版本号的完整本地化应用标签。通用错误码、内核、下载等词不能证明应用身份。显式源码路径仍优先，普通源码范围不能靠记忆正文自证适用。

搜索和上下文记忆返回 recall.matchedTerms、recall.channels。诊断脚本另显示候选名次、作用域、作用域是否接受、排除阶段、预算和响应大小：

~~~powershell
npx tsx scripts/recall-audit.ts <snapshot.db> <expected-memory-id> output/audit-20261103-first-batch/recall-after.json
~~~

同一真实快照的 8 条问法全部 Top-1、全部进入 3000 Token 上下文；首轮记录搜索约 1.4–7.1ms，上下文约 5.8–45.6ms，582–2837 Token。数字是本机测量，不代表所有项目性能。自动回归包含 24 条同主题问法及源码作用域隔离；既有多主题质量评估仍通过。这不是 24 个独立业务主题，跨主题真实问题集仍应在后续积累。

回退返回页数有上限，但技术词兼容查询仍需扫描符合状态的记忆文本；非常大的长期记忆库需要额外性能评估。过时记录仍被默认排除，替代关系和原来源不变；检索历史配置不能证明机器当前实时状态。

## T01 / T02：兼容字段与操作

生命周期仍为 in_progress/completed/cancelled。检查点新增可选字段，无数据库 schema 迁移：

| stage | 含义 |
| --- | --- |
| untriaged | 待核对；旧记录缺失字段时的显示值 |
| backlog | 待排期 |
| executing | 执行中；新 task_start 默认值 |
| acceptance | 待验收 |
| waiting | 等待外部条件，必须写 waitingReason |
| paused | 用户明确暂缓，必须写 waitingReason |

acceptance 为 {criterion, status: pending或passed, evidence?} 数组。完成时要求最终结论（summary 或 completed）、无必要 next/blockers、所有验收项通过且有非空证据。执行阶段与验收阶段均可在满足条件后完成。残余风险可以保留，但不能把原定必要验证藏到风险里。软件校验结构，代理仍须对证据真实性和目标覆盖负责。

旧调用仍可读取、写检查点，所有省略字段保留已有值，显式空数组清空对应字段；旧任务在关闭前必须补齐验收条件。完成后只允许补充说明，修改验证、验收条件、阶段或必要工作须显式重新打开。task_reopen 必须传 requestId 和 expectedRevision（最新 task_history sequence），清除当前完成状态，追加带 :reopen 来源的兼容 checkpoint 事件，原完成时间仍在不可改写历史里；重新验收后才能再次关闭。同请求延迟重试返回当前状态，不重复重开。父子任务不会自动级联完成。

~~~powershell
node dist/cli.js task query --status in_progress --stage waiting
node dist/cli.js task workflow <project-id> <task-id> --file workflow.json
node dist/cli.js task checkpoint <project-id> <task-id> --summary '实现完成，保留原验收项'
node dist/cli.js task checkpoint <project-id> <task-id> --clear next blockers
node dist/cli.js task reopen <project-id> <task-id> --reason '补齐原定现场验收' --request-id reopen-1 --expected-revision <最新历史序号>
~~~

Web 队列展示阶段、下一动作或等待原因，支持阶段筛选；详情可以编辑阶段、必要下一步、验收项和证据。重新打开保留历史。共享任务接收同样验收字段、使用相同完成校验；共享页面可编辑验收条件。旧版进程不能执行新校验，构建后需要重启/重新连接相关 MCP/Web 服务。

## 验证

- 改动前 npm run typecheck 通过。
- npm test：50 文件、409 项通过；随后新增 HTTP 鉴权/阶段/重开用例及布局修正，聚焦 6 文件、72 项通过；最终增加同时间戳并发版本校验，任务/API/界面 4 文件、28 项通过。
- npm run typecheck、npm run build、npm run eval 通过。
- Playwright 隔离数据：完成拒绝 → 补齐证据 → 完成 → 重开 → 历史保留；阶段筛选、恢复全部阶段通过。
- 表单保存以更新时间和历史序号双重校验，拒绝旧页面覆盖同毫秒的新检查点；解除阻塞可在详情清空。最新版浏览器保存通过并保留待验收状态。
- 视觉检查：1440px 桌面、390px 窄屏、200% CSS 放大以及 720px 布局；长标题、连续代码、阶段徽章、验收表单、历史展开、任务卡片横向滚动及计数展示。窄屏按钮挤压已发现并修正；最终页面宽度/滚动宽度均为 390，按钮均为 76×36。截图保存在 output/playwright/。
- 本页面无可隐藏/恢复的表格列，也无金额统计卡；未声称覆盖其他业务页面的这些场景。共享页面变更由 HTTP/远程团队集成测试覆盖，未做真实团队部署视觉验收。

本轮未合并/提交 Git、未修改旧业务任务或搬迁记忆归属；现有窗口仍使用旧进程，需重新连接才能应用新行为。

## 第一批复查修正（2026-11-03 09:27）

先新增反例，确认省略字段丢失、失败验证放行、旧结论截断、应用串扰、跨生命周期重开重放均失败，再修正实现。审计另用第二个数据库连接在导出后新增任务，确认恢复统计仍为导出时的一条记录。

| 修正 | 文件与行为 |
| --- | --- |
| 检查点与完成校验 | src/tasks/task-service.ts、src/core/app.ts、src/mcp/server.ts、src/team/knowledge-service.ts、src/cli.ts：原始 patch 用于幂等哈希，事务内合并，省略保留；CLI 支持 --clear。当前 verification 每个命令的最后一条结果必须通过，后续同命令通过可替代旧失败；不同命令不能冲销失败。修改验证范围必须显式更新并保留历史，验收证据仍需代理核实。 |
| 候选排名与完整词 | src/memory/recall-service.ts：技术词标题/内容覆盖在 LIMIT 前排序，完整 ASCII 标识符边界过滤 NO_PROXY_SUFFIX 等子串；FTS 结果也核对完整词。没有增加候选上限或塞入全部记忆。 |
| 应用身份 | src/context/context-service.ts、src/memory/knowledge-recall.ts：审核实体证据在作用域过滤前参与身份判断，仍受原源码路径边界约束；旧版中文应用标题以相同版本号与完整标签兼容。没有版本/审核别名的旧标签可能需要后续人工补证。 |
| 重开幂等 | 任务服务及 MCP/CLI/Web 全部要求 requestId + expectedRevision。回执复用现有备份/同步表，以独立命名空间避免和检查点冲突；浏览器网络失败后复用原请求。 |
| 审计一致性 | scripts/audit-baseline.ts、scripts/audit-snapshot.ts：注册表项目清单取备份副本，任务/记忆/候选统计取知识包恢复副本，实时索引单列 readAt，数据库句柄在 finally 关闭。 |

实际验收：

- `npm test`：52 文件、421 项全部通过，日志 output/review-fixes-tests-final.log。新增/扩展 task-workflow、task-cli、task-api、mcp、team-knowledge、remote-pack、knowledge-recall、recall-regression、audit-snapshot 测试，覆盖接口、省略/清空、失败复验、跨生命周期重试、备份恢复回执和作用域反例。
- `npm run typecheck`、`npm run build`、`npm run eval` 全部通过；既有质量集 Search Recall@5 = 1、MRR = 0.87，上下文召回/精度 = 1，预算满足。
- `npx tsx scripts/recall-audit.ts <snapshot.db> <expected-memory-id> output/recall-review-fixes-final.json`：8/8 搜索 Top-1、8/8 进入上下文；582–2837 Token；搜索约 1.8–9.6ms，上下文约 6.6–43.4ms。仅代表这份快照和本机测量。
- 密集干扰测试：140 条较新 NO_PROXY 记录不挤掉旧标题结论；520 条 NO_PROXY_SUFFIX 不冒充完整标识符。24 种同主题问法中，缺应用身份的“内核下载400修好了没有”仍能搜到候选，但不会自动把应用结论放入上下文；其余 23 条上下文命中。另有跨应用、未审/撤销别名和显式文件路径反例。
- `npx tsx scripts/audit-baseline.ts output/audit-20261103-review-fixes`：32 项目恢复成功、0 失败，注册表副本可打开；快照计数 35 个唯一未完成任务，包含审计当时的本轮修复任务。该数字不是最早业务清单的恒定数量，后续整理应重新核对快照。
- 浏览器最新隔离页面：首次网络失败后再次点击，reason/requestId/expectedRevision 不变；成功后新增一条重开历史，旧完成历史保留。跨生命周期延迟重试由 MCP/API/core 与恢复测试覆盖。模拟网络失败产生的 console ERR_FAILED 属预期。
- 视觉检查：1440px 桌面、390px 窄屏、200% CSS 放大；长标题、连续代码、徽章、数量统计、横向任务卡片、历史与验收表单。页面无横向溢出；截图 output/playwright/review-*.png。无可隐藏列或金额统计卡，本次未声称覆盖其他业务页面；200% CSS 放大不等同于浏览器原生缩放。

存量任务与记忆清理仍属于 D01/D02/M01 后续批次。本轮保留所有旧业务记录，未提交 Git，未重启其他窗口的常驻 MCP/Web 进程；这些进程需重新连接新版构建。

## 再次交付复查（2026-11-03 09:56）

用户授权按代理交付标准继续完善。本轮先确认新的反例，再针对现有实现修正，没有扩展到存量清理。

| 问题与结果 | 主要文件 |
| --- | --- |
| 原界面用正则子串判断通过，not passed、incomplete、not ok 可能显示成功。现在与完成校验共享同一函数，默认展示每个命令的最新结果，旧结果可展开并明确标为历史。阅读旧验证时暂停自动刷新。 | src/tasks/task-verification.ts、src/tasks/task-service.ts、src/ui/assets.ts |
| 明确指定另一已登记应用，但同时提到 NO_PROXY 时，共享环境作用域可以绕过应用限制。现在先识别明确应用身份，再判断资源范围；只问 NO_PROXY 仍可跨应用查找。BitBrowser-7.2.0 这类完整应用名称可以召回，返回 application-identity 原因；NO_PROXY_SUFFIX 不再当作 NO_PROXY 作用域。 | src/context/application-scope.ts、src/context/context-service.ts |
| Web 详情正文与历史版本原先来自两次读取；现在在同一数据库事务返回。页面完成/取消携带版本号，遇到其他窗口更新会拒绝并提示刷新。MCP expectedRevision 与 CLI --expected-revision 同步支持；为了兼容，旧调用省略该参数仍按原方式工作。 | src/tasks/task-service.ts、src/core/app.ts、src/ui/server.ts、src/ui/assets.ts、src/mcp/server.ts、src/cli.ts |
| 历史索引失败总数原先直接引出当前搜索可能不完整的告警。现在区分最新已结束运行成功/失败；历史失败保留，后续成功不等于完整性证明，也不能仅凭历史失败认定当前损坏。 | src/context/context-service.ts |

验证命令与证据：

- 修改前后 `npm run typecheck` 均通过，`npm run build` 通过。
- `npm test`：53 文件、426 测试全部通过，output/round3-tests.log。随后仅补充旧验证展开时暂停刷新，`npx vitest run tests/ui.test.ts tests/task-api.test.ts tests/task-verification.test.ts` 再次 13/13 通过，output/round3-final-ui-tests.log。
- `npm run eval`：通过，output/round3-eval.json；真实快照仍为 8/8 Top-1、8/8 上下文命中，582–2846 Token，output/round3-recall.json。该次与全量测试并行，耗时不能直接与上一轮空闲测量比较。
- 新增/扩展 tests/task-verification.test.ts、tests/recall-regression.test.ts、tests/task-workflow.test.ts、tests/task-api.test.ts、tests/mcp.test.ts、tests/task-cli.test.ts，验证否定状态、历史替代、跨应用共享资源、完整应用名、索引提示和陈旧操作。
- 最新隔离浏览器页面：当前 1 项通过、3 项未通过，旧 failed 折叠保留；模拟另一写入后，旧页面完成/取消均返回 TASK_UPDATE_CONFLICT，任务未关闭。1440px 桌面、390px 窄屏、200% CSS 放大均实看，长命令、文本、历史展开与按钮无溢出；证据 output/playwright/round3-verification-*.png。没有隐藏列/金额统计卡，不代表其他业务页面已验收。
- `git diff --check` 通过；未提交 Git，未变更旧业务任务。

边界：应用身份清单来自当前有效的 external-local-app 记录，最多扫描 2048 条轻量记录，最多额外召回 8 条，达到上限会提示。未登记且无已审核别名的应用名称不能保证识别；中文标题同版本标签仍是旧数据兼容规则。完整版本名召回改善的是任务上下文，原始混合搜索接口没有因此变成应用专用查询。版本号省略的旧 API 调用不具备陈旧视图防护；跨生命周期自动重试应携带原版本。当前改动已构建，其他窗口的旧 MCP/Web 进程仍需重新连接。
