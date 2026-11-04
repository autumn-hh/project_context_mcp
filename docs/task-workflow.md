# 任务阶段、验收与重新打开 / Task workflow

适用于本地 MCP、CLI 和 Web。任务生命周期仍为 `in_progress` / `completed` / `cancelled`，工作阶段保存在 `checkpoint.stage`。更新源码后运行 `npm run build`，再重启 Web、重连所属客户端的 stdio MCP；旧进程不会自动加载新工具。

## 工作阶段

| 值 | 含义 / Meaning |
| --- | --- |
| `untriaged` | 待核对；旧记录缺失阶段时的查询与显示默认值 / Legacy records needing review |
| `backlog` | 待排期 / Unscheduled work |
| `executing` | 执行中；新任务默认值 / Active work, default for new tasks |
| `acceptance` | 待验收 / Required verification remains |
| `waiting` | 等待外部条件，必须填写原因 / External dependency, reason required |
| `paused` | 用户明确要求暂缓，必须填写原因 / Explicit user pause, reason required |

`waitingReason` 保存等待条件或用户暂缓决定。`task_query.stage` 只筛选未完成任务；与 `status: completed` 或 `cancelled` 同用时返回空集。`task_list` 保留兼容接口；跨项目、阶段和分页使用 `task_query`。阶段不是锁或后台调度器，需要代理主动维护。

## 检查点与完成条件

`task_checkpoint` 是字段级 patch：省略保留现值，传入数组替换整个字段，`[]` 显式清空。`verification`、`acceptance` 也遵循此规则。追加验证时应提交保留旧条目的完整数组。历史事件保留；相同 `requestId` 只用于相同载荷的重试。

完成前需要满足：

1. `summary` 或至少一条 `completed` 记录最终结论。
2. `next` 与 `blockers` 为空；阶段不能仍为 backlog、waiting、paused 或 untriaged。
3. 至少一项 `acceptance`，每项均为 `passed` 且有非空 `evidence`。
4. 每个已记录验证命令的最新一次结果通过。命令名去除首尾空格后精确分组；同命令后来的通过替代旧失败，其他命令的成功不会冲销失败。通过状态为 passed / pass / success / succeeded / ok，忽略大小写及首尾空格；not passed、skipped、incomplete 均不通过。

代码只检查记录结构，不会代替代理执行验收或判断证据真假。没有命令验证的任务也需要实际验收证据。阶段完成不能替代整体完成，父计划不会因子任务完成而自动关闭。

本地 MCP：先用 `task_checkpoint` 保存以下字段，再调用 `task_complete`。替换占位值为实际 ID 和证据：

~~~json
{
  "projectId": "<project-id>", "taskId": "<task-id>", "requestId": "acceptance-1",
  "stage": "acceptance", "summary": "修复完成，必要验收通过", "next": [], "blockers": [],
  "acceptance": [{"criterion": "目标行为正确", "status": "passed", "evidence": "<实际报告或来源>"}],
  "verification": [{"command": "npm test", "status": "passed", "summary": "<实际结果与覆盖范围>"}]
}
~~~

## CLI

~~~powershell
node dist/cli.js task start <project-id> "等待现场验收" --stage waiting --waiting-reason "等待设备上线"
node dist/cli.js task query --project <project-id> --status in_progress --stage acceptance
node dist/cli.js task checkpoint <project-id> <task-id> --summary "验收通过" --clear next blockers
node dist/cli.js task workflow <project-id> <task-id> --file acceptance.json
node dist/cli.js task history <project-id> <task-id> --limit 1
node dist/cli.js task complete <project-id> <task-id> --expected-revision <latest-sequence>
~~~

`acceptance.json` 只接收 stage、acceptance、waitingReason，例如：

~~~json
{
  "stage": "acceptance",
  "acceptance": [{"criterion": "必要验收完成", "status": "passed", "evidence": "<实际验证结果>"}]
}
~~~

`task checkpoint --clear` 可清空 completed、next、changedFiles、verification、blockers、risks。不要为了通过校验而清掉未解决的问题。CLI 的 `workflow` 不是 MCP 工具；MCP 使用 `task_checkpoint` 更新这些字段。

## 重新打开与版本保护

关闭的任务可补充说明，修改必要下一步、阻塞、验收、验证结果或阶段时需先重新打开。`task_reopen` 必填 reason、requestId、expectedRevision。后者取 `task_history` 最新事件的 `sequence`，不是时间戳或历史总条数。

~~~powershell
node dist/cli.js task history <project-id> <task-id> --limit 1
node dist/cli.js task reopen <project-id> <task-id> --reason "补做必要的窗口启动验证" --request-id reopen-1 --expected-revision <latest-sequence>
~~~

重新打开后为 in_progress / acceptance，原因进入下一步和新增待验收项，当前 completedAt 清空；原完成事件及时间保留。同请求延迟重试返回当前状态，不会把再次完成的任务重复打开。

完成和取消可选传 expectedRevision（CLI 为 --expected-revision），旧版本返回 TASK_UPDATE_CONFLICT。Web 在同一快照读取详情与版本，提交时自动携带版本。

## Web 与团队边界

任务流水线展示阶段、下一步、等待原因、验收证据和当前验证，旧验证可展开。筛选时保留内容与输入焦点，加载期间暂停旧结果操作；失败提示仍是上次结果，点击刷新可重试。尚无独立存量统计页，也不会自动合并迁移副本。

团队 `team_task_checkpoint` 接受阶段与验收字段，同样省略保留、数组替换，使用 expectedVersion 保护并发。`team_task_finish` 的完成动作遵守相同校验，取消无需验收。团队 HTTP 没有 task_reopen，不能把本地工具当作团队接口；遗漏验收由有权限的维护者处理或登记后续任务。

## English reference

Lifecycle status and work stage are separate. New tasks default to executing; backlog is unscheduled work. Waiting and explicitly user-paused tasks require waitingReason. Stage filters match unfinished tasks only.

Checkpoints are patches: omitted fields remain unchanged; arrays replace the entire field and [] clears it. Reuse a request ID only for an identical retry. Completion requires a final conclusion, no remaining next actions/blockers, passed acceptance criteria with evidence, and passing latest results for all recorded verification commands. Agents must verify the evidence themselves.

Read the newest task_history event's sequence as expectedRevision. task_reopen requires this revision, a reason and retry ID; it preserves the original completion event and adds pending acceptance work. Completion/cancellation optionally accept the revision too. Team tasks use expectedVersion and have no team reopen tool.

The Web queue preserves content while filtering and explains stale results on failure. Rebuild and restart Web/MCP processes after upgrading. Historical cleanup, automatic duplicate merging and a separate inventory dashboard are outside this change.
