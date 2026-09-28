# Web 展示契约

Web 在 `src/features/agents/` 内实现 activity timeline，按 `activity` 选择本地化标签和
动作名称。每条 Activity 在 UI 中只显示时间、动作和有实际明细的 `message`；`starting`、
`stopped` 和 `idle` 不重复显示固定生命周期文案。不显示 `level`、`launch_id`、
`client_seq` 或原始 activity discriminator；`level` 只用于视觉强调。
`running_command` 使用终端语义；
`reading_file`、`writing_file`、`editing_file` 使用对应文件操作语义；`warning` 和
`error` 使用对应视觉级别。业务标签可以按当前界面语言本地化，安全的 provider 错误或
警告文本保持原始语言与 wording。未知 activity 必须使用通用 activity 样式显示安全
文案，不能丢弃整条记录；`running_command`/`tool_started` 的当前状态标签只显示 Daemon
发来的通用标签（`toolActivityLabel`），命令、路径等参数摘要只在展开的工具行里以
entry 的 `toolInput` 展示，从不进入标题，标题直接显示 `detail`。前端完整显示文件操作和工具 Activity 的 `message`，
但不得自行补充 provider 未上报的内容。

Daemon 按约 350ms 的静默间隔分批发送 provider 的文本/thinking 增量（每帧各自成为一条
Activity），因此同一句发言可能拆成多条 Activity 帧；Web 在展示层把同一 launch、同一
subagent 归属、彼此相邻且中间没有其他条目（包括被隐藏渲染的工具调用，例如
`send_message`）的连续文本（或 thinking）帧合并为一行，按时间先后拼接原文，显示为一个
段落而不是逐帧的碎片行；已持久化的历史同样在读取时按这条规则合并，不需要改动
Daemon 或存储。

Activity timeline 是完整的按时间顺序工作记录，不是只读最新状态的
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
