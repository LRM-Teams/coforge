# 健康探针与指标

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
