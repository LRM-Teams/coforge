# CoForge 可观测性基线

状态：MVP 基线（实现约束）

更新时间：2026-08-27

本文定义 CoForge 各进程共享的最小可观测性契约。它只约束日志、探针和指标的语义，不锁定业务 RPC、数据库 schema、供应商或具体采集平台。

## 目标与非目标

基线必须回答三件事：请求或消息发生在哪里、当前实例是否能接收流量、失败后能否定位影响范围。MVP 不引入分布式 tracing 平台、日志 SaaS 或新的消息协议；如需接入，使用本文定义的字段和脱敏规则。

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
| `trace_id` | 未来接入 tracing 时使用；未接入时省略 |
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

Agent 的业务状态只有 `online` 和 `offline`，并由 daemon 本地的 Agent
runtime process 派生。`agent:status` 是低频状态转换事件，只在值发生变化时发送：进程
成功启动并可接收工作后发送 `agent:status(status=online)`；进程退出或被停止后发送
`agent:status(status=offline)`。`agent:status` 与 `agent:activity` 是两个独立的上报通道（两类消息），都通过 daemon 的 WSS 发送。服务端和
前端不得从某个错误字符串推导第三种状态，也不得在每个 activity 上重复发送 status。

Agent runtime 的生命周期明细和诊断通过 `agent:activity` 上报，而不是扩展状态。为使
Daemon、服务端存储和前端展示使用同一契约，每条 activity 固定使用以下业务字段：

| 事件 | 用途 | 是否改变 Agent 状态 |
| --- | --- | --- |
| `agent:status` | 携带 `online` 或 `offline`，报告状态变化 | 按 payload 变更 |
| `agent:activity` | 报告启动、执行、错误和警告明细 | 不改变 |

| 字段 | 语义 |
| --- | --- |
| `activity` | 稳定类型，例如 `running_command`、`reading_file`、`using_tool`、`error` |
| `level` | `info`、`warning` 或 `error` |
| `message` | 命令、workspace-relative 文件路径或 provider 原始诊断文本 |
| `occurred_at` | daemon 记录的 UTC RFC 3339 时间 |

第一批 activity 类型只定义实际需要的过程记录，不预先枚举 Agent 状态机：

| activity | 用途 |
| --- | --- |
| `starting` | 开始启动或重启 Agent runtime process |
| `stopped` | Agent runtime process 已停止或退出 |
| `turn_completed` | 一次 turn 执行完成 |
| `idle` | Agent 当前没有执行中的 turn |
| `running_command` | Agent 正在执行命令 |
| `reading_file` / `writing_file` / `editing_file` | Agent 的文件工具操作 |
| `error` / `warning` | 运行错误或可恢复警告 |

`starting`、`stopped`、`idle` 是 timeline 记录，不是新的 Agent 业务状态；当前状态仍只
由 `agent:status` 的 `online` / `offline` 表示。只有真正发生过程或观察结果时才记录
对应 activity，不能用定时 heartbeat 不断重复制造相同 activity。

```text
event: agent:activity
activity: running_command
level: info
message: <具体运行的命令>
```

`activity=running_command` 表示 Agent runtime 正在执行命令；`message` 只记录展示所需
的安全命令文本，不把 activity 类型和命令内容拼入 event name。后续需要记录启动、工具
调用或其他执行明细时，沿用 `agent:activity`，增加新的 discriminator 值和对应字段，
不增加 Agent 业务状态。Code Agent 的文件工具调用必须记录，至少包括：

```text
event: agent:activity
activity: reading_file | writing_file | editing_file
level: info
message: <目标文件路径>
```

`reading_file`、`writing_file` 和 `editing_file` 分别表示读取文件、创建/覆盖文件和修改
文件。`message` 是 Agent workspace 内的相对路径，供前端展示和 activity timeline 关联；
不得记录文件内容、完整 diff、prompt、绝对路径或隐藏在参数中的 secret。其他 Code Agent
工具也通过 `agent:activity` 记录工具类型和安全的目标摘要，provider-specific 工具名
不能扩散到上层状态模型。暂未纳入统一分类的工具使用 `activity=using_tool`，并在
`message` 中保留安全的工具名或目标摘要，不能因为 provider 增加工具就丢弃事件。

进程生命周期和 turn 生命周期必须按实际发生顺序记录。例如启动成功的顺序是
`agent:activity(starting)`、`agent:status(online)`；停止时记录
`agent:activity(stopped)`、`agent:status(offline)`，并且只在状态真正转换时发送一次
status。重启是在停止后再次记录 `starting`，成功后发送 `agent:status(online)`。一次 turn 完成后记录
`turn_completed`，没有执行中的 turn 时再记录 `idle`；这些 activity 不改变 Agent status。

事件 envelope 还必须包含 `agent_id`、`runtime_id`、关联的 `connection_id`、唯一
`event_id` 和该 connection 作用域内单调递增的 `sequence`。错误/警告
使用 `activity=error|warning`、对应的 `level`，并把 provider 返回的原始文本放在
`message`。原始文本必须保留 provider 的原始语言和 wording，不得翻译、改写或用
CoForge 自己的文案替换。`message` 只做必要的 secret 脱敏，
不得上传 token、prompt、完整响应或 provider 原始 stderr。启动阶段如果进程未达到可接收工作状态，不能
发送 `agent:status(status=online)`，并通过 `agent:activity` 记录启动明细。如果启动失败，
通过 `agent:activity` 记录启动错误；只有原本为 online 的进程因此退出，或状态确实从
online 变为 offline 时，才发送 `agent:status(status=offline)`。如果进程已经 online
后遇到错误或警告，通过 `agent:activity` 上报；只有进程随后退出时才发送
`agent:status(status=offline)`。

### WSS 顺序与重连

WebSocket 只保证单条连接存活期间的发送顺序，不能单独解决断线重连和重复投递。因此
daemon 必须先把 `agent:status` 和 `agent:activity` 写入本地 durable spool，
再通过 daemon 的 WSS 按 `sequence` 顺序发送。status 与 activity 共用
同一条 sequence，不为两类消息维护两套计数器。重连时从服务端确认的 sequence 继续 replay，
较大的 sequence 不得越过尚未确认的较小 sequence；重复发送由 `event_id` 或
`(workspace_id, computer_id, sequence)` 幂等去重。服务端保存和转发给 Web 时必须保留 sequence，Web
按 sequence 排序并去重；发现 gap 时等待 replay，不自行猜测或重排成另一种状态。不同
Workspace Connection 之间没有全局顺序保证。

错误至少覆盖这些归类：可执行文件不存在或无权限、工作目录或 skills 初始化失败、
provider 初始化/认证失败、模型或 reasoning 配置不支持、Agent capacity 不足、进程
异常退出、provider API 网络/认证/限流/额度错误、上下文或 token 限制、工具权限拒绝、
协议解析或超时失败。警告至少覆盖 provider 返回的 warning、接近限流或额度阈值、可重试
网络退避、上下文接近上限和可选能力不可用。具体 provider 错误必须在 adapter 内归类
为这些稳定类别，但不能因此翻译或覆盖 provider 的原始错误文案。stderr 只作为本地
诊断来源，不能直接作为发给服务端和前端的 `message`。

### Web 展示契约

Web 在 `src/features/agents/` 内实现 activity timeline，按 `activity` 选择本地化标签和
图标，统一显示 `message` 和 `occurred_at`。`running_command` 使用终端语义；
`reading_file`、`writing_file`、`editing_file` 使用对应文件操作语义；`warning` 和
`error` 使用对应视觉级别。业务标签可以按当前界面语言本地化，provider 原始错误或警告
`message` 不得翻译。未知 activity 必须使用通用 activity 样式显示原始 `message`，不能
丢弃整条记录。命令和路径使用等宽文本并允许复制；前端不得尝试渲染未上报的文件内容、
diff 或 prompt。

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
| `coforge_attention_acks_total` | counter | `CodeAgentSession`/`notify` 接受易失 attention 的 ACK 结果；不表示 durable accept 或 Agent 任务完成 |
| `coforge_restarts_total` | counter | 子进程或依赖重启次数 |

业务消息正文、用户标识、object key、URL、token 和高基数 ID 不得进入指标标签。指标无法替代 PostgreSQL canonical Message/read state、仅供 status/activity replay 的 daemon spool 或审计记录；attention 指标也不是消息 inbox、outbox 或 delivery ledger。

## 关联与故障定位

入口生成或转发 `request_id`，跨进程调用沿用同一 ID；异步重试创建新的 attempt 字段或事件，但保留原始关联 ID。日志、指标和健康结果必须能按 `service`、版本、时间窗口和稳定作用域关联。重启、drain、依赖失效、恢复和 rollback 都记录成独立生命周期事件。

在线 presence 只是一致性最终的 operational view。日志和指标可以记录 stale/unknown，但不得把它当成授权依据或 durable truth；完整 Workspace–Computer 枚举仍来自 PostgreSQL registration，具体协议和字段等待批准的 wire/identity 设计。

## 保留与访问

MVP 默认保留结构化运行日志 30 天、审计/发布证据 90 天；部署可延长但不可缩短安全审计所需窗口。日志收集器和指标端点只允许受控内网访问，Caddy 不把管理探针或指标公开给终端用户。导出和调试样本必须经过脱敏，访问受最小权限控制。

## 实施顺序

1. 先在 Web/backend、Computer 和 Daemon 统一 JSON logger、request ID 和敏感字段过滤。
2. 再为 daemon 和 Centrifugo 管理面接入同一事件字段与 liveness/readiness seam。
3. 最后接入指标采集与告警；在没有真实消费者前不锁定 tracing vendor 或云厂商协议。

架构总览与进程职责见 [`docs/architecture.md`](architecture.md)。
