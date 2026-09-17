# CoForge 可观测性基线

状态：MVP 基线（实现约束）

更新时间：2026-08-27

本文定义 CoForge 各进程共享的最小可观测性契约。它只约束日志、探针、指标和 tracing 的语义，不锁定业务 RPC 或数据库 schema。当前 Web/backend 的消息发送链路通过 OpenTelemetry OTLP 上报到阿里云北京接入点。

## 目标与非目标

基线必须回答三件事：请求或消息发生在哪里、当前实例是否能接收流量、失败后能否定位影响范围。当前 tracing 仅覆盖 Web/backend 的消息发送入口及其持久化/发布阶段；浏览器点击到请求发出的时延仍需前端性能数据补充。

## 结构化日志

所有 Computer、Daemon、Web/backend、Centrifugo 管理侧和运维脚本输出一条事件一行 JSON。默认写 stderr，由运行环境收集；CLI 的人读结果仍写 stdout，不能把日志混入机器可读结果。

保留字段：

| 字段 | 语义 |
| --- | --- |
| `ts` | UTC RFC 3339 时间 |
| `level` | `debug`、`info`、`warn` 或 `error` |
| `service` | 稳定进程名，如 `coforge-computer`、`coforge-daemon` |
| `event` | 稳定、低基数事件名；禁止把用户输入拼入事件名 |
| `version` | 构建版本或 commit；未知时省略 |
| `request_id` | 单次 HTTP/RPC/本地调用关联 ID；入口没有上游 ID 时生成 |
| `trace_id` | OpenTelemetry trace 标识；未产生 tracing 时省略 |
| `workspace_id` | 已确定作用域时记录稳定 ID，不记录 slug/name |
| `workspace_id` + `computer_id` | 已确定 Workspace–Computer connection 时记录 |
| `agent_id` / `runtime_id` | 已确定 Agent 作用域时记录 |
| `duration_ms` | 操作耗时，非负数 |
| `outcome` | `ok`、`retry`、`rejected`、`failed` 或 `unknown` |

`request_id`、`workspace_id`、`computer_id`、`agent_id` 和 `runtime_id` 是关联字段，不是授权依据。日志不得记录 access/refresh token、device code、API key、签名 URL、Cookie、Authorization header、私钥、完整文件内容、消息正文、原始上传路径或用户提供的 secret。外部错误只记录稳定错误码；详细网络/凭据诊断留在受控 debug 环境，仍须脱敏。

### 级别与采样

- `error`：操作失败且需要处理，必须包含稳定 `event`、`outcome=failed` 和可关联 ID。
- `warn`：可恢复异常、退避或拒绝，不能用来掩盖失败。
- `info`：生命周期、发布、连接和状态转换；默认保留。
- `debug`：仅诊断细节，默认关闭；不得通过提高级别绕过脱敏。

事件名和标签必须低基数。禁止把 request ID、消息 ID、URL、文件名或任意用户输入作为 metric label 或 event name。

## Agent 状态与活动上报通道

Agent 的业务状态只有 `active` 和 `inactive`，Web 分别显示为在线和离线。`active` 表示
Daemon 持有可运行配置并能接受消息，不要求 Agent runtime process 当前存在。首次启动成功后发送
`agent:status(status=active)`，并每 30 秒刷新一次 90 秒租约；进程意外退出时保持
`active`，新消息到达后重新启动。人工停止发送 `agent:status(status=inactive)` 并立即清除
租约。Daemon/Computer 正常关闭也必须在关闭 WSS 前为其管理的 active Agent 发送
`inactive`；只有崩溃、断电或断网等无法上报的异常才依赖租约自然回落为 `inactive`。
Backend 每次接受状态上报后都通过 Workspace 授权的 Centrifugo status channel 向浏览器
发布状态和租约截止时间。页面首次加载及 WSS 重连读取 Redis 快照，平时不轮询 backend；
若续租事件停止，页面在截止时间本地显示为离线。
`agent:status` 与 `agent:activity` 是两个独立的上报通道（两类消息），都通过 daemon 的 WSS 发送。Activity 使用专用的 `agent:activity:<workspace_id>` namespace 做 best-effort publication；服务端和
前端不得从某个错误字符串推导第三种状态，也不得在每个 activity 上重复发送 status。

Agent runtime 的生命周期明细和诊断通过 `agent:activity` 上报，而不是扩展状态。为使
Daemon、服务端存储和前端展示使用同一契约，每条 activity 固定使用以下业务字段：

| 事件 | 用途 | 是否改变 Agent 状态 |
| --- | --- | --- |
| `agent:status` | 携带 `active` 或 `inactive`，报告状态变化 | 按 payload 变更 |
| `agent:activity` | 报告启动、执行、错误和警告明细 | 不改变 |

| 字段 | 语义 |
| --- | --- |
| `activity` | 稳定类型，例如 `running_command`、`reading_file`、`using_tool`、`error` |
| `level` | `info`、`warning` 或 `error` |
| `message` | `running_command` 保留命令前 100 个 Unicode 字符；文件读写、编辑和工具 Activity 完整保留 provider 消息；错误和警告使用 provider 处理后的诊断文本 |
| `occurred_at` | daemon 记录的 UTC RFC 3339 时间 |
| `launch_id` | 每次实际 OS process launch 的新身份；替换后不得复用 |
| `client_seq` | 同一 `launch_id` 内从 1 开始严格递增的 daemon 序号 |

第一批 activity 类型只定义实际需要的过程记录，不预先枚举 Agent 状态机：

| activity | 用途 |
| --- | --- |
| `starting` | 开始启动或重启 Agent runtime process |
| `stopped` | Agent runtime process 已停止或退出 |
| `idle` | Agent 当前没有执行中的 turn（一次 turn 完成） |
| `running_command` | Agent 正在执行命令 |
| `reading_file` / `writing_file` / `editing_file` | Agent 的文件工具操作 |
| `launch_failed` / `stop_failed` | 启动或安全回收失败；使用脱敏后的可操作原因 |
| `error` / `warning` | provider 运行错误或可恢复警告 |

ADR 0021 在 `detailKind` 上新增了以下值，只在对应 provider 确有真实信号时才
上报；`packages/coforge-sdk/src/internal/index.ts` 的 `AGENT_ACTIVITY_DETAIL_KIND` 是
唯一权威定义：

| detailKind | 上报条件 | 展示 |
| --- | --- | --- |
| `tool_end` | Claude 的 `tool_result`、Codex 的 `item/completed`（命令）、Kiro 的 `tool_call_update` 终态、Pi 的 `tool_execution_end` | 可见，写入历史，Activity timeline 展示为一行状态行（主标题 Working，副标题“Tool finished”），不出现在头像 popover（ADR 0021 amendment） |
| `thinking_end` | Claude 的 thinking content block `content_block_stop`；Codex 的 `item/completed`（reasoning）；Kiro、Pi 无对应信号，不上报 | 同 `tool_end`，副标题“Thinking finished” |
| `compacting_context` | Claude 的 `system/status=compacting`（原先误报为 `runtime_progress`）；Kiro 的 ACP `compaction_update`（`status=in_progress`）；Codex 无对应信号 | 可见，写入历史，文案“Compacting context…” |
| `compaction_finished` | 上述两个 provider 各自的结束信号（Claude 的 `compact_boundary`；Kiro 的 `compaction_update` 转为非 `in_progress`） | 同 `tool_end`，副标题“Compaction finished”（ADR 0021 amendment；此前仅续租、不写入历史） |
| `subagent_activity` | 任意携带 subagent 归属（Claude `parent_tool_use_id`）的 trajectory entry；只有 Claude 产生这类归属 | 可见，写入历史，文案“Subagent working…” |
| `message_received` | 消息投递/唤醒后既有的“Message received”上报，改用这个 kind 而不是通用的 `model_request_started` | 可见，写入历史 |
| `runtime_crashed` | Claude、Codex 进程在非主动停止下意外退出（沿用既有的 `errorClass`/`errorReason`/`fingerprint`，只改 kind）；Kiro、Pi 目前没有等价的进程级信号，意外退出仍报 `stopped` | 可见，写入历史，视为错误 |
| `runtime_interrupted` | 主动 stop/restart 打断了一个正在忙碌（working/thinking）的 turn | 可见，写入历史，视为在线 |
| `runtime_unavailable` | ADR 0040：Daemon 检测到已存的 native Session 无法恢复——缺失（kiro/pi 的 `session_missing`，或 Claude/Codex 驱动内部静默替换）或被 provider 拒绝 replay（`provider_replay_rejected`）；上报一次 `agent:session:invalidate` 后，以同一 `launchId` 冷启动新 session | 可见，写入历史，视为 working |

`starting`、`stopped`、`idle` 是 timeline 记录，不是新的 Agent 业务状态；当前状态仍只
由 `agent:status` 的 `active` / `inactive` 表示。只有真正发生过程或观察结果时才记录
对应 activity，不能用定时 heartbeat 不断重复制造相同 activity——但见下方的忙碌心跳例外
（ADR 0016）：为了不让安静运行超过 60 秒的 turn（一条 shell 命令或一次安静的模型调用）
在展示层被误判为 online，Daemon 在 Agent 处于 `working`/`thinking` 时，每 60 秒
（`ACTIVITY_HEARTBEAT_MS`）重发最近一条忙碌 Activity，显式标记 `is_heartbeat=true`、
`client_seq` 递增、`entries` 为空。服务端把这类心跳（以及下方的 `runtime_progress`）
仅用于把展示租约 `WORKING_LEASE_MS` 续期到 90 秒，并保持 `working`/`thinking`；不写入
`agent_activities` 历史，也不计入前端“最近活动”列表；只有可见状态真的变化时才推进
`agent:display` 的 revision。`runtime_progress` 是新增的 discriminator，用于 provider
产生的、没有可渲染文本的 stream/system 事件（例如 Claude Code 的压缩状态通知、Codex 的
原始 reasoning 增量、Kiro 的压缩进度通知）；Daemon 按 Agent 把它限流到最多每 10 秒一条，
同样不产生新的 Agent 业务状态。

心跳只覆盖续租，不覆盖租约已经到期之后的情形：租约一旦到期，服务端没有可信来源，只能在
下一次读写时把 Agent 惰性投影为 `online`。为此服务端自己运行一个 liveness sweep（ADR
0020），而不是等浏览器按需触发：`OBSERVE_ACTIVITY`/`OBSERVE_STATUS` 维护一个按
`expiresAt` 排序的 lease 索引（busy 时 `ZADD`，转为非 busy 或 `inactive` 时 `ZREM`）；
`AgentActivitySweep` 每 5 秒（`ACTIVITY_SWEEP_INTERVAL_MS`）在一个 Redis 锁下 tick 一次
（`NX PX 4500`，未抢到锁的实例整轮跳过，保证同一时刻整个集群只有一个实例在扫描），批量
取出已过期的 lease，对每个成员运行 `SWEEP_STALE`：还新鲜则从索引移除；刚过期且未探测过
则记录一次待定探测并向其 Daemon 发布新的 `agent:activity_probe` 意图；已探测但仍在等待则
跳过；探测已经等待超过 `ACTIVITY_PROBE_TIMEOUT_MS`（5 秒）则判定为不可达，清除可见忙碌
状态并直接把结果推给 `agent:status:<workspace_id>`，浏览器不必等自己下一次刷新就能看到
Agent 变回 online。Daemon 用一条普通 `agent:activity` 应答（重发最近一条忙碌 Activity 并
带上 `probe_id`，或在 Agent 已转为 idle 时回复 `idle`）；服务端把这条应答当成真实观测处理，
而不是当成心跳：只有心跳和 `runtime_progress` 本身不改变可见状态，探测应答可以把展示从
`working`/`thinking` 纠正为 `idle`，也可以续租并保持忙碌，并清除该 Agent 待定的探测记录。
探测应答同样不写入 `agent_activities` 历史，也不进入前端“最近活动”列表。浏览器自身完全
不发起探测请求；`useAgentStatuses` 只是把 `expiresAt` 之后的 `refresh()` 再推迟
`ACTIVITY_PROBE_TIMEOUT_MS + 1000ms`，作为 sweep 推送丢失时的兜底，而不是触发探测的手段。

```text
event: agent:activity
activity: running_command
level: info
message: bun test packages/daemon/test/daemon-runtime.test.ts
```

`activity=running_command` 表示 Agent runtime 正在执行命令；持久化的 `message` 使用
provider 上报命令的前 100 个 Unicode 字符，超出部分由 Daemon 截断，不把 activity 类型
和命令内容拼入 event name。非 CoForge CLI 的 shell 命令先复用 trajectory 文本相同的脱敏
规则（`redactTrajectoryText`）再截断：命令中出现的第一个 `<<`（heredoc 起始）之前截断，
heredoc 正文永远不进入 `message`，随后才截断到前 100 个字符；命令参数中能被规则识别的
token/secret/password 等敏感片段会被替换为 `[REDACTED]`，但这仍是尽力而为的脱敏，不保证
覆盖所有敏感文本。

当命令的第一个 token 是 `coforge` 或以 `/coforge` 结尾的路径时，Daemon 把它解析为语义
工具，只记录该工具预先约定的安全摘要字段，从不使用原始命令行或消息正文（`message send`
之后的 heredoc 消息体同样不会出现在 `message` 里）；`message check`/`inbox check` 使用
`checking_messages` 而不是 `running_command`/`tool_started`：

| CoForge CLI 子命令 | 语义工具 | 摘要 |
| --- | --- | --- |
| `message send` | `send_message` | `--target` |
| `message check` | `check_messages`（`checking_messages`） | 无 |
| `message read` | `read_history` | `--target` |
| `message search` | `search_messages` | `--query`（截断到 120 字符） |
| `message resolve` / `message react` | `resolve_message` / `react_message` | 无 |
| `inbox check` | `check_inbox`（`checking_messages`） | 无 |
| `channel mute` / `unmute` | `mute_channel` / `unmute_channel` | `--target` |
| `thread unfollow` | `unfollow_thread` | `--target` |
| `task list/create/convert/claim/unclaim/assign/update/amend/history/delete/receipt` | `list_tasks` 等对应的 `*_task(s)` | `--target`，若有 `--number` 则附加 `#<n>` |
| `attachment view` | `view_file` | 无 |
| `reminder schedule` | `schedule_reminder` | `--title`（截断到 40 字符） |
| `reminder list` | `list_reminders` | 无 |
| `reminder update/snooze/cancel/log/ack/dismiss` | 对应的 `*_reminder`/`reminder_log` | `--id` 前 8 位 |
| `weekly-report *` | `weekly_report` | 无 |
| 其他 `coforge` 子命令 | `coforge_cli` | 无 |

`glob`、`grep`、`web_fetch`、`web_search`、`todo_write` 等 Code Agent 工具同样只从一个预先
约定的参数字段取摘要（`pattern`/`query`/`url`，均有长度上限），或在没有对应字段、以及未纳入
统一分类的工具上只记录工具名；provider 上报的其他参数（例如 prompt、diff、密码等自由文本）
永远不拼入 `message`。后续需要记录启动、工具
调用或其他执行明细时，沿用 `agent:activity`，增加新的 discriminator 值和对应字段，
不增加 Agent 业务状态。Code Agent 的文件工具调用必须记录，至少包括：

```text
event: agent:activity
activity: reading_file | writing_file | editing_file
level: info
message: <provider 上报的完整原始消息>
```

`reading_file`、`writing_file` 和 `editing_file` 分别表示读取文件、创建/覆盖文件和修改
文件。Daemon 完整保留这三类 Activity 的 provider `message`，不截断、替换或额外脱敏。
其他 Code Agent 工具也通过 `agent:activity` 记录；暂未纳入统一分类的工具使用
`activity=using_tool`，其 provider `message` 同样完整保留。这里的原始消息是 provider 已经
归一化后交给 Daemon 的消息，不是 provider 的完整协议事件。

进程生命周期和 turn 生命周期必须按实际发生顺序记录。例如启动成功的顺序是
`agent:activity(starting)`、`agent:status(active)`；停止时记录
`agent:activity(stopped)`、`agent:status(inactive)`；租约刷新不新增 Activity。
重启是在停止后再次记录 `starting`，成功后发送 `agent:status(active)`。一次 turn 完成后记录
`idle`，不带固定生命周期文案；这些 activity 不改变 Agent status。
进程意外退出时记录 `stopped`，但只要 Daemon 仍持有可重启配置就不发送 `inactive`；下一条
消息会先重启 runtime，再发送无正文通知，并在通知成功后 ACK。

Activity envelope 包含 `request_id`、`workspace_id`、`agent_id` 和上述固定业务字段；
`request_id` 只用于关联诊断。`launch_id` 与 `client_seq` 是观察端未来拒绝旧 launch 和
旧序号的可信依据，但当前 Web 没有跨连接的 current-launch 事实来源，不伪装提供服务端
stale rejection；当前保证来自 Daemon 的 current-launch gate。
生命周期错误使用 `activity=launch_failed|stop_failed` 和 `level=error`，只发送稳定、
脱敏且可操作的原因，不上传命令参数、绝对路径、凭据或 stderr。provider 错误/警告
使用 `activity=error|warning` 和对应的 `level`；provider 必须先移除 token、prompt、命令、
路径、完整响应和 stderr，再保留安全错误文本的原始语言与 wording。启动阶段如果进程未达到可接收工作状态，不能
发送 `agent:status(status=active)`，并通过 `agent:activity` 记录启动明细。如果启动失败，
通过 `agent:activity` 记录启动错误。进程已经 active 后遇到错误、警告或意外退出时，通过
`agent:activity` 上报；只要仍可由新消息重启就保持 `active`。只有人工停止、没有可重启配置，
或 Daemon 租约失效时才呈现为 `inactive`。

### WSS Activity 发送

Activity 是观测数据，不采用可靠消息语义。Daemon 调用 Centrifugo client publication 后
立即继续，不等待业务确认；不写 spool，也不影响 Agent 生命周期、状态或聊天消息。
断线期间只在内存中为每个 Agent 替换保存最新一条 Activity；新 launch 会淘汰旧 launch
pending，重连后每个 Agent 最多刷新这一条。显式 stop 清空 pending。该 bounded refresh
不是历史 replay；publish proxy 或 observer 失败仍直接丢弃且不重试。
Centrifugo 仅在 `activity` namespace 开启 publish proxy；Backend 根据服务端附加的连接
metadata 校验 Workspace、Computer、Agent 与 payload scope，并禁止 Daemon 向 control
channel 发布。通过校验的 observation 按 `(agent_id, launch_id, client_seq)` 幂等写入
PostgreSQL；`computer_id` 只取可信 connection metadata，不接受 payload 自报。Agent
详情页读取最近 500 条持久 observation，并用最近一条展示最近观测到的 Computer。写入
失败不会反向改变 publication 结果，因此该历史仍可能缺项。单条连接通常保留发送次序，
但消费者不得依赖 Activity 完整、有序或唯一。

错误至少覆盖这些归类：可执行文件不存在或无权限、工作目录或 skills 初始化失败、
provider 初始化/认证失败、模型或 reasoning 配置不支持、Agent capacity 不足、进程
异常退出、provider API 网络/认证/限流/额度错误、上下文或 token 限制、工具权限拒绝、
协议解析或超时失败。警告至少覆盖 provider 返回的 warning、接近限流或额度阈值、可重试
网络退避、上下文接近上限和可选能力不可用。具体 provider 错误必须在 provider 内归类
为这些稳定类别，原始错误只作为本地诊断；stderr 不能直接作为发给服务端和前端的
`message`。

### Web 展示契约

Web 在 `src/features/agents/` 内实现 activity timeline，按 `activity` 选择本地化标签和
动作名称。每条 Activity 在 UI 中只显示时间、动作和有实际明细的 `message`；`starting`、
`stopped` 和 `idle` 不重复显示固定生命周期文案。不显示 `level`、`launch_id`、
`client_seq` 或原始 activity discriminator；`level` 只用于视觉强调。
`running_command` 使用终端语义；
`reading_file`、`writing_file`、`editing_file` 使用对应文件操作语义；`warning` 和
`error` 使用对应视觉级别。业务标签可以按当前界面语言本地化，安全的 provider 错误或
警告文本保持原始语言与 wording。未知 activity 必须使用通用 activity 样式显示安全
文案，不能丢弃整条记录；前端显示 Daemon 已截断的命令，并完整显示文件操作和工具
Activity 的 `message`，但不得自行补充 provider 未上报的内容。

Daemon 按约 350ms 的静默间隔分批发送 provider 的文本/thinking 增量（每帧各自成为一条
Activity），因此同一句发言可能拆成多条 Activity 帧；Web 在展示层把同一 launch、同一
subagent 归属、彼此相邻且中间没有其他条目（包括被隐藏渲染的工具调用，例如
`send_message`）的连续文本（或 thinking）帧合并为一行，按时间先后拼接原文，显示为一个
段落而不是逐帧的碎片行；已持久化的历史同样在读取时按这条规则合并，不需要改动
Daemon 或存储。

Activity timeline 是完整的按时间顺序工作记录（ADR 0021 amendment），不是只读最新状态的
展示层：除忙碌心跳（`is_heartbeat=true`）和 liveness probe 应答（带 `probe_id`）外，其余
每条 Activity 都写入历史并出现在 timeline 里，`tool_end`/`thinking_end`/
`compaction_finished` 也不例外，渲染为一行状态行（主标题沿用现有 activity-kind 分类，
副标题说明具体完成了什么）。`runtime_progress` 保持原状——只续租、不落库、不展示。
`thinking_started`/`model_response_started` 会先以不带 `entries`、`detail` 为空的
"run-start marker" 上报一次（只用于让展示状态立即翻转到 thinking/working，不代表有可读
内容），再在有实际文本时补发一条带 `entries` 的正式帧；Web 按 `detailKind` 和 `entries`
是否为空识别并丢弃前者，只保留带 `entries` 的正式帧进历史和 timeline。`tool_end`/
`thinking_end` 的副标题优先使用 daemon 上报的 `detail`（当前 daemon 发送 "Tool
finished"/"Thinking finished"），仅当 `detail` 为空（旧版 daemon、或改版前已落库的历史
行）时才回退到 Web 自己的措辞；服务端在持久化前不改写、不清空这个 `detail`。

## 健康与就绪探针

每个长期运行进程至少提供进程级 liveness 和接流量 readiness；探针响应不包含 secret 或业务数据。`liveness` 只表示进程事件循环仍工作，`readiness` 表示实例已完成配置加载、必要依赖可用且没有进入 drain。依赖不可用时返回 `503` 和稳定错误类别，不能伪装为健康。

探针检查应有有界超时，并记录 `health.check` 事件及 `duration_ms`。探针本身不能触发迁移、发布、重连风暴或改变 canonical 数据。

## MVP 指标

指标采用 Prometheus 兼容的单调 counter 或 gauge；具体暴露端点和采集器由部署实现决定。至少覆盖：

| 指标 | 类型 | 说明 |
| --- | --- | --- |
| `coforge_process_info` | gauge | 进程版本与构建信息（值恒为 1） |
| `coforge_process_starts_total` | counter | 进程启动次数 |
| `coforge_requests_total` | counter | 按 `service`, `operation`, `outcome` 聚合的入口调用数 |
| `coforge_request_duration_seconds` | histogram | 入口调用延迟 |
| `coforge_health_checks_total` | counter | 按 `service`, `check`, `outcome` 聚合 |
| `coforge_connections` | gauge | 当前连接数，按 `service` 和受控连接类型聚合 |
| `coforge_reconnects_total` | counter | 有界重连次数与结果 |
| `coforge_attention_pending` | gauge | 当前进程内等待交给 Agent session 的易失 attention 数量；重启后不恢复 |
| `coforge_attention_acks_total` | counter | `AgentSession`/`notify` 接受易失 attention 的 ACK 结果；不表示 durable accept 或 Agent 任务完成 |
| `coforge_restarts_total` | counter | 子进程或依赖重启次数 |

业务消息正文、用户标识、object key、URL、token 和高基数 ID 不得进入指标标签。指标无法替代 PostgreSQL canonical Message/read state 或审计记录；Activity 指标不代表完整历史，attention 指标也不是消息 inbox、outbox 或 delivery ledger。

## 关联与故障定位

入口生成或转发 `request_id`，跨进程调用沿用同一 ID；异步重试创建新的 attempt 字段或事件，但保留原始关联 ID。日志、指标和健康结果必须能按 `service`、版本、时间窗口和稳定作用域关联。重启、drain、依赖失效、恢复和 rollback 都记录成独立生命周期事件。

在线 presence 只是一致性最终的 operational view。日志和指标可以记录 stale/unknown，但不得把它当成授权依据或 durable truth；完整 Workspace–Computer 枚举仍来自 PostgreSQL registration，具体协议和字段等待批准的 wire/identity 设计。

## 保留与访问

MVP 默认保留结构化运行日志 30 天、审计/发布证据 90 天；部署可延长但不可缩短安全审计所需窗口。日志收集器和指标端点只允许受控内网访问，Caddy 不把管理探针或指标公开给终端用户。导出和调试样本必须经过脱敏，访问受最小权限控制。

## 实施顺序

1. 先在 Web/backend、Computer 和 Daemon 统一 JSON logger、request ID 和敏感字段过滤。
2. 再为 daemon 和 Centrifugo 管理面接入同一事件字段与 liveness/readiness seam。
3. 接入指标采集与告警，并根据真实消息发送链路补充前端性能关联。

## OpenTelemetry Tracing

Web/backend 为一次 `sendDirectConversationMessage` 创建 `message.send` 根 span，并包含
`message.context` 和 `message.persist_and_publish` 子 span。仅记录 request ID 和 Agent ID，
不记录消息正文、凭据、Cookie 或接入 Token。导出采用 OTLP/HTTP protobuf 的批量发送，导出失败
不得阻塞消息发送。

部署通过 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_FILE` 从 Compose secret 读取完整接入地址；完整
地址只存在于 GitHub Environment Secret 和远端受限文件中，不进入 Git、镜像、`.env`、日志或发布
记录。`OTEL_SERVICE_NAME` 和 `OTEL_DEPLOYMENT_ENVIRONMENT` 是非敏感运行配置。

架构总览与进程职责见 [`docs/architecture.md`](architecture.md)。
