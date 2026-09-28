# 关联、保留与实施顺序

## 关联与故障定位

入口生成或转发 `request_id`，跨进程调用沿用同一 ID；异步重试创建新的 attempt 字段或事件，但保留原始关联 ID。日志、指标和健康结果必须能按 `service`、版本、时间窗口和稳定作用域关联。重启、drain、依赖失效、恢复和 rollback 都记录成独立生命周期事件。

在线 presence 只是一致性最终的 operational view。日志和指标可以记录 stale/unknown，但不得把它当成授权依据或 durable truth；完整 Workspace–Computer 枚举仍来自 PostgreSQL registration，具体协议和字段等待批准的 wire/identity 设计。

## 保留与访问

MVP 默认保留结构化运行日志 30 天、审计/发布证据 90 天；部署可延长但不可缩短安全审计所需窗口。日志收集器和指标端点只允许受控内网访问，Caddy 不把管理探针或指标公开给终端用户。导出和调试样本必须经过脱敏，访问受最小权限控制。

staging 的全部容器使用 Docker `journald` 日志驱动，写入 rootless `deploy` 用户的持久化 journal（主机把 `/var/log/journal` bind mount 到数据盘 `/data/journal`，保留 30 天），因此部署重建容器后日志仍在；默认 `json-file` 日志会随容器一起删除。按容器名用 `journalctl --user -t <容器名>` 查询，主机一次性配置与查询方式见 [`docs/operations/staging/container-logs.md`](../operations/staging/container-logs.md)。集中式采集（如阿里云 SLS）留待生产环境按需决定。

## 实施顺序

1. 先在 Web/backend、Computer 和 Daemon 统一 JSON logger、request ID 和敏感字段过滤。
2. 再为 daemon 和 Centrifugo 管理面接入同一事件字段与 liveness/readiness seam。
3. 接入指标采集与告警，并根据真实消息发送链路补充前端性能关联。
