# 结构化日志

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

## 级别与采样

- `error`：操作失败且需要处理，必须包含稳定 `event`、`outcome=failed` 和可关联 ID。
- `warn`：可恢复异常、退避或拒绝，不能用来掩盖失败。
- `info`：生命周期、发布、连接和状态转换；默认保留。
- `debug`：仅诊断细节，默认关闭；不得通过提高级别绕过脱敏。

事件名和标签必须低基数。禁止把 request ID、消息 ID、URL、文件名或任意用户输入作为 metric label 或 event name。
