# `running_command` 与工具摘要

`activity=running_command` 表示 Agent runtime 正在执行命令；持久化的 `message`（`detail`）
固定是一个不含参数的通用标签（`toolActivityLabel`，`packages/coforge-sdk/src/internal/
tool-display.ts`，Daemon 和 Web 共用同一张别名/标签表），例如「Running command…」「Reading
file…」，已知工具取其标签，未知工具退化为「Using `<name>`…」（`name` 截断到 20 个 Unicode 码点）；这个
标签从不由参数推导，Agent 状态栏标题因此不可能泄漏原始命令或路径。命令、路径、pattern、URL
等参数摘要改为只出现在同一帧 `tool_start` entry 的 `toolInput` 字段里，不再拼入 `message`。
非 CoForge CLI 的 shell 命令，`toolInput` 先复用 trajectory 文本相同的脱敏规则
（`redactTrajectoryText`），随后截断到前 200 个 Unicode 码点；命令参数与 heredoc 正文中能被规则
识别的 token/secret/password 等敏感片段会被替换为 `[REDACTED]`，但这仍是尽力而为的脱敏，不保证
覆盖所有敏感文本。这里**不再**在第一个 `<<` 处截断：参考客户端（Raft Computer 1.0.32 的
`summarizeToolInput`，`summaryKind: "command"`）直接上报 `input.command` 并只做长度截断，我们此前
「heredoc 正文永不进入 `toolInput`」的规则是自己加的，会让 `cd x && python3 - <<'EOF' …` 这类命令在
界面上只剩 `cd x && python3 -`，读不出它在做什么；对齐后内联脚本的开头可见（代价是 heredoc 正文
进入尽力脱敏的范围）。`toolInput` 还要满足 SDK 的 `validToolInput`（至多 200 个 Unicode 码点、不含控制字符）：换行等控制字符先被替换为空格再合并空白，一条多行命令也不会因此
无法解码。全篇的长度上限统一按 Unicode 码点计算（见 `truncate.ts`），不会把代理对拆散。

当命令的第一个 token 是 `coforge` 或以 `/coforge` 结尾的路径时，Daemon 把它解析为语义
工具，只记录该工具预先约定的安全摘要字段作为 `toolInput`，从不使用原始命令行或消息正文
（`message send` 之后的 heredoc 消息体同样不会出现在 `message` 或 `toolInput` 里）；
`message check` 使用 `checking_messages` 而不是 `running_command`/`tool_started`。语义工具集是
一个封闭集合，与参考客户端（Raft Computer 1.0.32 的 `resolveRaftCliInvocation`）保持一致：
集合内的子命令才有语义身份，集合外的一律照普通命令上报，不再有代表"某个 CoForge 命令"的
占位工具名。`inbox check` 不在集合内——它问的是 Computer 本地还握着什么，服务端 drain 才是
`message check`：

| CoForge CLI 子命令 | 语义工具 | `toolInput` 摘要 |
| --- | --- | --- |
| `message send` | `send_message` | `--target` |
| `message check` | `check_messages`（`checking_messages`） | 无 |
| `message read` | `read_history` | `--target` |
| `message search` | `search_messages` | `--query`（截断到 120 个 Unicode 码点） |
| `message resolve` / `message react` | `resolve_message` / `react_message` | 无 |
| `channel mute` / `unmute` | `mute_channel` / `unmute_channel` | `--target` |
| `thread unfollow` | `unfollow_thread` | `--target` |
| `task list/create/convert/claim/unclaim/assign/update/amend/history/delete/receipt` | `list_tasks` 等对应的 `*_task(s)` | `--target`，若有 `--number` 则附加 `#<n>` |
| `attachment view` | `view_file` | 无 |
| `reminder schedule` | `schedule_reminder` | `--title`（截断到 40 个 Unicode 码点） |
| `reminder list` | `list_reminders` | 无 |
| `reminder update/snooze/cancel/log/ack/dismiss` | 对应的 `*_reminder`/`reminder_log` | `--id` 前 8 个 Unicode 码点 |
| `weekly-report *` | `weekly_report` | 无 |
| 其他 `coforge` 子命令（含 `inbox check`、`workspace info`） | 无语义工具：照普通命令上报 `bash`/`running_command`，`toolInput` 为脱敏截断后的命令本身 |

`glob`、`grep`、`web_fetch`、`web_search`、`todo_write` 等 Code Agent 工具同样只从一个预先
约定的参数字段取 `toolInput` 摘要（`pattern`/`query`/`url`，均有长度上限），或在没有对应
字段、以及未纳入统一分类的工具上不带 `toolInput`；provider 上报的其他参数（例如 prompt、
diff、密码等自由文本）永远不拼入 `message` 或 `toolInput`。后续需要记录启动、工具
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
使用 `activity=error|warning` 和对应的 `level`；provider 只上报原始事实（消息文本，以及
可选的 provider 原生错误代码/类别提示），从不自行分类；provider 的报错文案按上报原样
显示，进程崩溃摘要的脱敏和长度上限，以及分类为[稳定类别](activity-delivery-and-errors.md)，都是 Daemon 核心
（`packages/daemon/src/agent-runtime/runtime-error-activity.ts`）唯一的职责，
见[「错误与重连的单一转换点」](activity-delivery-and-errors.md)。启动阶段如果进程未达到可接收工作状态，不能
发送 `agent:status(status=active)`，并通过 `agent:activity` 记录启动明细。如果启动失败，
通过 `agent:activity` 记录启动错误。进程已经 active 后遇到错误、警告或意外退出时，通过
`agent:activity` 上报；只要仍可由新消息重启就保持 `active`。只有人工停止、没有可重启配置，
或 Daemon 租约失效时才呈现为 `inactive`。
