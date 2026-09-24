# CoForge 可观测性基线

状态：MVP 基线（实现约束）

更新时间：2026-08-27

本文定义 CoForge 各进程共享的最小可观测性契约。它只约束日志、探针、指标和 tracing 的语义，不锁定业务 RPC 或数据库 schema。当前 Web/backend 的消息发送链路通过 OpenTelemetry OTLP 上报到阿里云北京接入点。

## 目标与非目标

基线必须回答三件事：请求或消息发生在哪里、当前实例是否能接收流量、失败后能否定位影响范围。当前 tracing 仅覆盖 Web/backend 的消息发送入口及其持久化/发布阶段；浏览器点击到请求发出的时延仍需前端性能数据补充。

## 目录

- [结构化日志](structured-logging.md): 结构化日志的保留字段、敏感信息禁区、级别与采样。
- [Agent 状态与活动上报通道](agent-status-and-activity.md): Agent 状态与活动两条上报通道、activity 字段与类型、忙碌心跳与 liveness sweep。
- [`running_command` 与工具摘要](running-command-summary.md): `running_command` 的通用标签与 `toolInput` 摘要、CoForge 语义工具表、文件工具与生命周期顺序。
- [Activity 发送与错误转换](activity-delivery-and-errors.md): WSS Activity 的 best-effort 发送，以及错误与重连的单一转换点。
- [Web 展示契约](activity-web-display.md): Web 的 activity timeline 展示契约。
- [健康探针与指标](health-and-metrics.md): liveness/readiness 探针与 MVP 指标。
- [关联、保留与实施顺序](correlation-and-retention.md): 关联与故障定位、日志保留与访问、实施顺序。
- [OpenTelemetry Tracing](tracing.md): Web/backend 消息发送链路的 OpenTelemetry tracing。
