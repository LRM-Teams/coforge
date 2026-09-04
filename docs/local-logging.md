# CoForge 本地应用日志契约

状态：设计已固定，代码实现待后续 TDD 变更

更新时间：2026-08-27

本文定义 `coforge-computer`、`coforge-daemon`、daemon 和 Agent runtime process 的本地诊断日志。日志是可删除的运行诊断数据，不是消息、delivery、授权或审计的 canonical source of truth。

## 1. 框架选择

实现使用 LogTape，不自研 logger 或文件滚动器。进入实现时重新核对 latest stable，并将以下 package 固定为同一精确版本；本文调研时的 stable 是 2.3.2：

- `@logtape/logtape`：structured logging、hierarchical category、level 和 lifecycle；
- `@logtape/file`：官方 rotating file sink、buffer 和 periodic flush；
- `@logtape/redaction`：field-based 与 pattern-based redaction。

三者均由 LogTape 项目维护、采用 MIT license，并明确支持 Bun。Bun 自身提供 `console`、文件 I/O 和 child-process stream，但不是包含 category、redaction、rolling 与 retention 的日志框架。

LogTape 的社区规模小于传统 Node.js logger，但当前需求直接使用同一项目维护的 Bun runtime、category、rotation、redaction 和 lifecycle interface，不需要拼接多个 logging framework 或第三方 rolling transport。Computer 和 Daemon 只允许这一套 logging stack；若固定版本在 compiled Bun binary 中失败，先停止实现并重新评审选型，不得静默引入第二套 logger 或自定义 rolling sink。

## 2. 进程和日志命名

| 名称                  | 软件角色                                                 | 日志中的 `process_role` |
| --------------------- | -------------------------------------------------------- | ----------------------- |
| `coforge-computer`    | 用户安装入口和 machine-level supervisor application      | `computer`              |
| `coforge-daemon`      | OS/Computer 托管的唯一 daemon                            | `daemon`                |
| Agent runtime process | daemon 启动并跨 prompt 复用的 provider execution process | `agent-runtime`         |

`computer` 是本地产品入口；`daemon` 只用于后台服务；`Agent` 是产品中的逻辑协作者，不可用来指代 OS 进程。

## 3. 本地目录和分类

日志根目录固定为 `<coforge-data-dir>/logs`。`coforge-data-dir` 是 CoForge 自己的 per-user application data directory，和非敏感配置、安装状态及未来本地 spool 共用一个受管理根目录；日志不得另行散落到当前工作目录或平台的独立 log root。

`coforge-data-dir` 的 Linux/macOS/Windows 物理位置由本地 storage layout 设计一次性固定；该决定尚未完成，日志模块不得抢先发明 `~/.coforge`、`Library/Logs/CoForge` 或另一套 root。测试可以显式注入临时 data directory。

CoForge data directory 和 `logs/` 权限必须限制为当前用户，Unix mode 为 `0700`；活动和滚动文件为 `0600`。启动时拒绝 symlink root、不可写目录和权限无法收紧的文件。

每个 hierarchical category 写独立 LogTape rotating file sink；业务模块只取得 category logger，不直接配置 sink。Computer 和 Daemon 分别拥有自己的 sink，不允许两个 OS 进程并发 append 同一个文件：

| Owner / category                       | Dedicated directory and files      | 内容                                                                                        |
| -------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| Computer / `coforge.computer`          | `computer/computer.jsonl[.1…5]`    | install/upgrade、interactive command lifecycle、daemon start/stop 和 health observation     |
| Computer / `coforge.computer.security` | `computer/security.jsonl[.1…5]`    | login、credential-store、local control authorization 和 policy violation                    |
| Daemon / `coforge.daemon`              | `daemon/daemon.jsonl[.1…5]`        | supervisor lifecycle、配置加载结果、Agent runtime lifecycle 事件                            |
| Daemon / `coforge.daemon.security`     | `daemon/security.jsonl[.1…5]`      | workspace/Agent authorization、credential boundary 和 policy violation                      |
| Daemon / `coforge.workspace`           | `daemon/workspace.jsonl[.1…5]`     | Workspace lifecycle、WSS/reconnect、delivery accept/replay 和本地 spool 状态                |
| Daemon / `coforge.agent`               | `daemon/agent-runtime.jsonl[.1…5]` | Agent runtime process lifecycle、provider handshake、skills discovery、interrupt 和退出状态 |

所有 workspace 和 Agent 共用固定分类，通过稳定 id 关联；不得按 workspace/Agent 动态创建无上限目录或 sink。Computer 与 Daemon 通过 `machine_id`、`workspace_id` 和 `request_id` 关联记录，不通过共写文件关联。每个 process directory 只包含该进程拥有的日志，retention cleanup 不得影响另一进程或无关文件。

## 4. JSONL record

每行是一个完整 UTF-8 JSON object，至少包含：

```json
{
  "timestamp": "2026-08-27T12:00:00.000Z",
  "level": "info",
  "category": "coforge.agent",
  "event": "agent_runtime:started",
  "service": "coforge-daemon",
  "version": "0.1.0",
  "process_role": "daemon",
  "pid": 1234
}
```

可选关联字段使用稳定名称：`machine_id`、`workspace_id`、`agent_id`、`runtime_id`、`provider`、`delivery_id`、`request_id`、`attempt`、`duration_ms`、`exit_code` 和 `signal`。缺失值省略，不写 `null` 占位。异常只保存稳定 `error_code`、安全的 `error_message` 和必要 stack；跨进程原始 envelope 不直接展开进 record。

event 使用低基数、过去式的 `namespace:action` name，例如 `daemon:started`、`daemon_runtime:restarted`、`agent_runtime:skills_loaded`。动态 id、provider error text 和路径不得拼入 event name。

LogTape levels 统一为 `debug`、`info`、`warning`、`error`、`fatal`。默认最低级别为 `info`；仅显式本地诊断会话启用 `debug`。正常重连和受控退出不是 error；只有需要操作或导致能力不可用的失败使用 error/fatal。

## 5. 滚动、保留和 flush

每个分类使用 `getRotatingFileSink()`：

- 活动文件达到 10 MiB 时按 `.1` 到 `.5` 滚动；
- 每个分类保留一个活动文件和最多五个历史文件；因为 buffer/record 可以越过阈值，约 60 MiB/分类、360 MiB 六分类总量是目标上界而不是字节级硬限制；
- 首版不压缩，避免崩溃恢复和用户排障依赖额外解压步骤；
- buffer 上限 8 KiB，最多每 1 秒 flush；
- Computer command exit、正常 stop/upgrade 和 worker replacement 必须调用 LogTape `dispose()` 并等待 flush；
- 不使用会静默忽略 background flush error 的 non-blocking mode。启动无法安全创建所有 sink 时 daemon 不进入 ready；运行中写入失败时 health 变为 degraded，并向继承的 `stderr` 最多输出一条脱敏 fallback 诊断。

滚动文件是诊断保留，不承担 durable queue 语义。安装器不得把日志打进升级包；卸载是否保留日志由后续安装体验决定。

## 6. 数据最小化和脱敏

默认永不记录：

- bearer token、refresh credential、API key、cookie、authorization header、pairing grant 或 credential-store value；
- 完整环境变量、命令行 secret、signed URL；
- 用户 prompt、Agent response、conversation message；
- tool input/output、文件内容、patch/diff 和 shell stdout；
- Agent runtime process 的原始 stdout 或 stderr。

Agent stdout 是 driver control channel，只能解析，不能复制到日志。Agent stderr 可能包含 provider 输出、路径或 secret，因此只记录 byte count、退出状态和经过 driver 归类的稳定 error code，不保存原文。

所有 sink 先经过 `redactByField()` 的默认敏感字段和 CoForge credential 字段，再经过 JWT、authorization header、signed URL 与 provider key 的 pattern redaction。redaction 是最后一道保护，不替代调用点的数据最小化。截断上限和恶意深层对象使用 LogTape 的 traversal limit；相关测试必须证明 secret 在 active/rotated file、fallback stderr 和 error stack 中都不存在。

## 7. 后续实现和验证门槛

实现时先确认两个 public test seam：日志配置启动/关闭，以及运行一个真实 child-process fixture 后读取本地文件。最小门槛：

1. 在 Bun 1.4 compiled Computer 和 Daemon 中验证六类 LogTape sink、JSONL schema、level routing 和 graceful flush；
2. 达到 10 MiB 后验证 `.1`…`.5` 顺序、count limit、专用目录隔离和跨重启继续滚动；
3. 验证 Linux/macOS/Windows 路径选择和 owner-only 权限；
4. 注入 token、JWT、signed URL、prompt、tool output 和 provider stderr，证明 active/rotated/fallback output 均不泄漏；
5. 模拟磁盘满、目录不可写、文件被替换、异常退出和 sink dispose timeout；
6. 验证日志失败不会被误报为 Computer command success 或 daemon ready，并能从 health surface 定位 degraded 原因。

## 8. 官方资料

- LogTape [overview and Bun support](https://logtape.org/)
- LogTape [file and rotating file sinks](https://logtape.org/sinks/file)
- LogTape [hierarchical categories](https://logtape.org/manual/categories)
- LogTape [data redaction](https://logtape.org/manual/redaction)
- Bun [file I/O](https://bun.com/docs/runtime/file-io)
- Bun [child process output streams](https://bun.com/docs/runtime/child-process)
