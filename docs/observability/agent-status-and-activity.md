# Agent 状态与活动上报通道

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
| `message` | `running_command`/`tool_started` 固定为不含参数的通用标签（详见[「`running_command` 与工具摘要」](running-command-summary.md)，例如「Running command…」「Reading file…」）；命令、路径等参数摘要只出现在 `tool_start` entry 的 `toolInput` 字段里，从不拼入 `message`；文件读写、编辑和工具 Activity 完整保留 provider 消息；错误和警告使用 Daemon 核心处理后的诊断文本（provider 只上报原始事实，见[错误与重连的单一转换点](activity-delivery-and-errors.md)） |
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

`detailKind` 上还有以下值，只在对应 provider 确有真实信号时才
上报；`packages/coforge-sdk/src/internal/index.ts` 的 `AGENT_ACTIVITY_DETAIL_KIND` 是
唯一权威定义：

| detailKind | 上报条件 | 展示 |
| --- | --- | --- |
| `tool_end` | Claude 的 `tool_result`、Codex 的 `item/completed`（命令）、Kiro 的 `tool_call_update` 终态、Pi 的 `tool_execution_end`；detail 固定为 “Tool finished” | 可见，写入历史，Activity timeline 展示为一行状态行（主标题 Working，副标题“Tool finished”），不出现在头像 popover |
| `thinking_end` | 由 Daemon 从归一化事件流中统一推导（`ActivityTrajectory`）：一次 thinking 运行开始后，下一个 text-delta、tool-start、tool-end、compaction activity、turn 结束或 error 到来时上报一次；对每个 provider 都成立，不依赖各 provider 的专属信号；detail 固定为 “Thinking finished” | 同 `tool_end`，副标题“Thinking finished” |
| `compacting_context` | Claude 的 `system/status=compacting`（原先误报为 `runtime_progress`）；Kiro 的 ACP `compaction_update`（`status=in_progress`）；Pi/CoForge 的 SDK `compaction_start` 事件；Codex 无对应信号。自 2026-09-18 起，provider 只上报归一化的 `compaction-started`/`compaction-finished`/`compaction-interrupted`/`progress` 信号（`packages/agent/src/contract.ts`），由 Daemon core（`packages/daemon/src/agent-runtime/compaction-tracker.ts`）统一去重（同一次压缩只报一次“开始”）并决定是否上报 Activity | 可见，写入历史，文案“Compacting context…” |
| `compaction_finished` | 上述 provider 各自的结束信号（Claude 的 `compact_boundary`；Kiro 的 `compaction_update` 转为 `completed`；Pi/CoForge 的 `compaction_end`，未被中止时）。Daemon core 还会在压缩仍处于打开状态时，从恢复输出（文本/thinking）、新工具调用或 turn 结束推断出压缩已结束，并在这些信号自身的 Activity 之前上报 | 同 `tool_end`，副标题“Compaction finished”（此前仅续租、不写入历史） |
| `subagent_activity` | 任意携带 subagent 归属（Claude `parent_tool_use_id`）的 trajectory entry；只有 Claude 产生这类归属 | 可见，写入历史，文案“Subagent working…” |
| `message_received` | 消息投递/唤醒后既有的“Message received”上报，改用这个 kind 而不是通用的 `model_request_started` | 可见，写入历史 |
| `runtime_crashed` | 四个 provider 一致：进程在非主动停止下意外退出，且退出前最近一次 `error` 事实还没有被 `completed` 事件解决（`errorClass`/`errorReason`/`fingerprint` 由 Daemon 核心统一分类，见[「错误与重连的单一转换点」](activity-delivery-and-errors.md)）；否则报 `idle` | 可见，写入历史，视为错误 |
| `runtime_interrupted` | 主动 stop/restart 打断了一个正在忙碌（working/thinking）的 turn | 可见，写入历史，视为在线 |
| `runtime_unavailable` | Daemon 检测到已存的 native Session 无法恢复——缺失（kiro/pi 的 `session_missing`，或 Claude/Codex 驱动内部静默替换）或被 provider 拒绝 replay（`provider_replay_rejected`）；上报一次 `agent:session:invalidate` 后，以同一 `launchId` 冷启动新 session | 可见，写入历史，视为 working |

`starting`、`stopped`、`idle` 是 timeline 记录，不是新的 Agent 业务状态；当前状态仍只
由 `agent:status` 的 `active` / `inactive` 表示。只有真正发生过程或观察结果时才记录
对应 activity，不能用定时 heartbeat 不断重复制造相同 activity——但见下方的忙碌心跳例外：为了不让安静运行超过 60 秒的 turn（一条 shell 命令或一次安静的模型调用）
在展示层被误判为 online，Daemon 在 Agent 处于 `working`/`thinking` 时，每 60 秒
（`ACTIVITY_HEARTBEAT_MS`）重发最近一条忙碌 Activity，显式标记 `is_heartbeat=true`、
`client_seq` 递增、`entries` 为空。服务端把这类心跳（以及下方的 `runtime_progress`）
仅用于把展示租约 `WORKING_LEASE_MS` 续期到 90 秒，并保持 `working`/`thinking`；不写入
`agent_activities` 历史，也不计入前端“最近活动”列表；只有可见状态真的变化时才推进
`agent:display` 的 revision。`runtime_progress` 是新增的 discriminator，用于 provider
产生的、没有可渲染文本的 stream/system 事件（例如 Claude Code 的部分 stream 帧、Codex 的
原始 reasoning 增量、Kiro 的 `tool_call_update`/`plan`/`usage_update` 通知、Pi/CoForge 的
turn/message 生命周期事件）；这些信号自 2026-09-18 起统一上报为归一化的 `progress` 事件
（`packages/agent/src/contract.ts`），由 Daemon core（`packages/daemon/src/agent-runtime/
runtime-progress.ts`）决定是否上报——不再是固定的“每 10 秒最多一条”限流，而是只在 Agent
当前这次 launch 尚未显示为忙碌（working/thinking）时才上报一次；一旦已经忙碌，同样的信号
只刷新存活时间戳，不重复产生 Activity，同样不产生新的 Agent 业务状态。

心跳只覆盖续租，不覆盖租约已经到期之后的情形：租约一旦到期，服务端没有可信来源，只能在
下一次读写时把 Agent 惰性投影为 `online`。为此服务端自己运行一个 liveness sweep，而不是等浏览器按需触发：`OBSERVE_ACTIVITY`/`OBSERVE_STATUS` 维护一个按
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
message: Running command…
entries: [{ kind: "tool_start", toolName: "bash", toolInput: "bun test packages/daemon/test/daemon-runtime.test.ts" }]
```
