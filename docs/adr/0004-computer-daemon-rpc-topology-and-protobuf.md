---
status: accepted
date: 2026-08-27
---

# Computer/Daemon 使用单一 Daemon runtime RPC 连接

CoForge Computer 是低频的用户操作入口，Daemon 才是机器级常驻进程。每个逻辑
Workspace 需要独立的连接身份、重连状态、投递 cursor 和 durable spool；因此不能
让 Computer 维护云端长连接，也不能让一个 Daemon 把所有 Workspace 复用成一个业务
session。

## 决定

- `coforge-computer` 不维护云端长期 WebSocket。它只通过本地 UDS（Windows 使用等价
  的命名管道）调用 `coforge-daemon`。
- Daemon 的托管保持用户级边界：Linux/Windows 由 Computer 按需启动和复用；macOS
  由 Computer 安装用户级 `launchd` LaunchAgent，让系统负责登录启动和崩溃重启。
  不注册系统级服务，不要求 sudo，Computer 仍以本地 RPC handshake 确认 Daemon 已就绪。
- 一个 `coforge-daemon` 监督零个或多个 daemon runtime；每个 daemon runtime
  恰好绑定一个逻辑 Workspace，并独立持有一条到 Centrifugo 的 WSS 长连接。
- Computer/Daemon 发往服务端的业务通信统一使用 CoForge 自定义 RPC；Computer 与
  Daemon 之间也使用版本化的本地 CoForge RPC。Computer/Daemon 不调用业务 REST
  endpoint。
- OAuth Device Authorization、安装包和 release metadata 是明确的 HTTPS 例外。OAuth
  只建立用户授权上下文，不成为 Daemon 或 Agent 的长期身份。
- 云端业务 RPC 使用 Centrifugo 官方客户端连接/RPC mechanics，CoForge 只定义业务
  method、权限、幂等、错误和 payload schema；不重新实现 WebSocket framing、心跳或
  重连，也不恢复 custom realtime gateway。
- Computer/Daemon 的业务 payload 使用 Protobuf。schema 通过 `.proto` 维护并生成
  TypeScript 类型；不同时维护 JSON fallback。
- RPC method 使用 Centrifugo 原生 namespace boundary：`<namespace>:<method>`，例如
  `computer:register`、`daemon_runtime:ready`、`daemon_runtime:code_agents_update`。
  日志 event name 也统一使用相同的 `namespace:action` 分隔规则。
- setup 使用 Workspace 页面提供的可读 slug（例如 `lrm-team`），不暴露内部
  Workspace ID，也不在 Computer 端列出或选择 Workspace。服务端根据 slug 和当前
  User authorization context 创建或确认短时、一次性的 setup intent；intent 只绑定
  一个 Workspace 和发起用户。
- Computer 注册是用户主动授权的操作，使用 User authorization context；注册后由
  Backend 颁发 Computer/Workspace session credential 给 Daemon。User credential
  不持久化到 Daemon，不进入 Agent runtime，也不用于普通 Daemon reconnect。
- `daemon_runtime:code_agents_update` 只上报需要探测的用户安装 runtime（当前为 Codex 和
  Claude Code）。CoForge Agent runtime 随 Daemon payload 固定交付，不通过
  PATH 扫描，也不作为本机发现结果；其版本来自已验证的 release
  manifest/package metadata。
- Agent 对产品和 Web 只暴露两个业务状态：`online` 和 `offline`。Runtime 的
  `starting`、`stopped`、`ready`、`unavailable` 以及任务开始/结束等信息属于 activity
  timeline 明细，不是额外的 Agent 状态；不要把它们扩展成更多业务状态。

## 连接和身份模型

```text
Computer --local RPC--> Daemon
                           ├── Worker A --WSS + CoForge RPC--> Centrifugo --> Backend
                           ├── Worker B --WSS + CoForge RPC--> Centrifugo --> Backend
                           └── Worker C --WSS + CoForge RPC--> Centrifugo --> Backend
```

每条 worker 连接的服务端上下文必须绑定 `computer_id` 和 `workspace_id`；二者共同
标识这条 Workspace–Computer 绑定。Worker A 的断线、重启或 replay 不得影响 Worker B。
Daemon 是 supervisor，
不是所有 Workspace 的共享业务 session。

## 方法命名和协议范围

首批 method namespace 包括：

- `computer:register`
- `workspace:registration_activate`
- `daemon_runtime:ready`
- `daemon_runtime:resume`
- `daemon_runtime:code_agents_update`
- `computer:revoke`
- `workspace:revoke`
- `message:publish` / `message:committed`

`daemon_runtime:ready` 表示该 Worker 已完成本地启动、认证和 WSS 建立，可以接收该
Workspace 的业务消息；它不是用户登录，也不是 Agent runtime ready。断线恢复使用
`daemon_runtime:resume`。具体 field、错误码、capability、deadline、Protobuf package 和生成工具在实现前必须
通过协议兼容性检查。未知 major、错误 audience、缺少 required capability 和错误
Workspace connection 必须 fail closed。

## 未选择的方案

- **Computer 与 Daemon 各自维护云端 WSS**：增加连接、凭据和状态同步面，且 Computer
  的低频用户操作不需要长期连接。
- **Daemon 为所有 Workspace 复用一条业务连接**：降低连接数但破坏 Workspace 权限、
  故障隔离、cursor、replay 和 durable spool 边界。
- **Computer/Daemon 使用 REST endpoint**：会分散 method、幂等、重连和错误契约，也
  不适合 Daemon 的双向长期 session。
- **自研 WebSocket/RPC framing**：重复 Centrifugo 已提供的成熟 transport mechanics，
  增加维护和安全风险。
- **JSON 与 Protobuf 双轨**：造成两套字段、默认值、错误和兼容性行为，增加 Code
  Agent 漂移风险。

## 后果、迁移与验证

- 一台机器绑定 N 个 Workspace 就有 N 条 worker WSS；这不是错误，而是隔离边界。
- Computer setup 的用户体验可以是单个 `setup` 流程；无凭据时在流程内部完成 OAuth，
  不要求用户先执行 `login` 或选择 Workspace。
- User token 的精确一次性授权转交方式、Computer credential 的 proof、RPC envelope、
  Protobuf codegen 和 Centrifugo→Web/backend Handler protocol 仍需作为实现 packet 固定；
  在此之前不得凭猜测添加生产 wire。
- 验证必须覆盖多 Workspace 并行连接、单 worker 故障隔离、单 worker 重连/replay、
  重复 register 幂等、User credential 不落盘、Protobuf breaking check 和未知 method
  fail closed。
- 回滚只能切换到仍支持同一 protocol major、audience 和 registration 语义的已验证 release
  set；不能通过回滚重新启用 Computer 云端长连接或 User token 的 Daemon 持久化。

## 一手资料

- Centrifugo [client RPC proxy](https://centrifugal.dev/docs/server/proxy)
- Centrifugo [client protocol](https://centrifugal.dev/docs/transports/client_api)
- Protocol Buffers [language guide](https://protobuf.dev/programming-guides/proto3/)
- Protocol Buffers [compatible changes](https://protobuf.dev/programming-guides/proto3/#updating)
