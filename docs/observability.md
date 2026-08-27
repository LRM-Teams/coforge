# CoForge 可观测性基线

状态：MVP 基线（实现约束）

更新时间：2026-08-27

本文定义 CoForge 各进程共享的最小可观测性契约。它只约束日志、探针和指标的语义，不锁定业务 RPC、数据库 schema、供应商或具体采集平台。

## 目标与非目标

基线必须回答三件事：请求或消息发生在哪里、当前实例是否能接收流量、失败后能否定位影响范围。MVP 不引入分布式 tracing 平台、日志 SaaS 或新的消息协议；如需接入，使用本文定义的字段和脱敏规则。

## 结构化日志

所有 Computer、Daemon、workspace worker、Web/backend、Centrifugo 管理侧和运维脚本输出一条事件一行 JSON。默认写 stderr，由运行环境收集；CLI 的人读结果仍写 stdout，不能把日志混入机器可读结果。

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
| `binding_id` | 已确定 Workspace–Computer binding 时记录 |
| `agent_id` / `runtime_id` | 已确定 Agent 作用域时记录 |
| `duration_ms` | 操作耗时，非负数 |
| `outcome` | `ok`、`retry`、`rejected`、`failed` 或 `unknown` |

`request_id`、`workspace_id`、`binding_id`、`agent_id` 和 `runtime_id` 是关联字段，不是授权依据。日志不得记录 access/refresh token、device code、API key、签名 URL、Cookie、Authorization header、私钥、完整文件内容、消息正文、原始上传路径或用户提供的 secret。外部错误只记录稳定错误码；详细网络/凭据诊断留在受控 debug 环境，仍须脱敏。

### 级别与采样

- `error`：操作失败且需要处理，必须包含稳定 `event`、`outcome=failed` 和可关联 ID。
- `warn`：可恢复异常、退避或拒绝，不能用来掩盖失败。
- `info`：生命周期、发布、连接和状态转换；默认保留。
- `debug`：仅诊断细节，默认关闭；不得通过提高级别绕过脱敏。

事件名和标签必须低基数。禁止把 request ID、消息 ID、URL、文件名或任意用户输入作为 metric label 或 event name。

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
| `coforge_delivery_pending` | gauge | 本地 durable spool 或 delivery ledger 的待处理数量 |
| `coforge_delivery_acks_total` | counter | durable accept/ACK 结果，不表示 Agent 任务完成 |
| `coforge_restarts_total` | counter | 子进程或依赖重启次数 |

业务消息正文、用户标识、object key、URL、token 和高基数 ID 不得进入指标标签。指标无法替代 PostgreSQL canonical 状态、daemon spool 或审计记录。

## 关联与故障定位

入口生成或转发 `request_id`，跨进程调用沿用同一 ID；异步重试创建新的 attempt 字段或事件，但保留原始关联 ID。日志、指标和健康结果必须能按 `service`、版本、时间窗口和稳定作用域关联。重启、drain、依赖失效、恢复和 rollback 都记录成独立生命周期事件。

在线 presence 只是一致性最终的 operational view。日志和指标可以记录 stale/unknown，但不得把它当成授权依据或 durable truth；完整 Workspace–Computer 枚举仍来自 PostgreSQL binding，具体协议和字段等待批准的 wire/identity 设计。

## 保留与访问

MVP 默认保留结构化运行日志 30 天、审计/发布证据 90 天；部署可延长但不可缩短安全审计所需窗口。日志收集器和指标端点只允许受控内网访问，Caddy 不把管理探针或指标公开给终端用户。导出和调试样本必须经过脱敏，访问受最小权限控制。

## 实施顺序

1. 先在 Web/backend、Computer 和 Daemon 统一 JSON logger、request ID 和敏感字段过滤。
2. 再为 workspace worker 和 Centrifugo 管理面接入同一事件字段与 liveness/readiness seam。
3. 最后接入指标采集与告警；在没有真实消费者前不锁定 tracing vendor 或云厂商协议。

架构总览与进程职责见 [`docs/architecture.md`](architecture.md)。
