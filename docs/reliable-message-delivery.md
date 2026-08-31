# 可靠消息投递设计（实施依据）

**范围：**本文定义当前 MVP 中一个 Workspace 内 User↔Agent 私聊的云端 canonical message、Daemon 投递、恢复和 Agent 回复边界。

**非目标：**本文不设计群聊、命令/工作流平台、数据库 mailbox、本地 durable spool、claim/lease、完整 delivery ledger 或新的 wire schema；这些都不能从本文推断为已经实现。当前代码仍是进行中的骨架，本文是后续实现和评审依据，不是实现完成声明。

## 端到端流程

```text
User
  │ 发送 Markdown/text（可带结构化附件）
  ▼
Web/backend
  │ 鉴权 → 校验 ConversationMember → 事务保存 Message + conversationSeq
  │ 事务提交后通过唯一 Agent transport channel 通知 Daemon
  ▼
Daemon connection（WSS/RPC，at-least-once）
  │ pending → accepted（CodeAgentSession 已接收责任）→ injected（已调用 session）
  ▼
provider-neutral CodeAgentSession.sendMessage(message)
  │
  ▼
Pi / Codex / Claude adapter → 对应 Agent runtime
  │
  └─ coforge message send --target <全站唯一 username> --body ...
                         ▼
             Daemon → WSS/RPC → Web/backend
                              │ 鉴权 target/发送者 → 保存反向 Message
                              ▼
                         Conversation 成员
```

这里的 `agent` 是唯一 transport channel；业务目标只取 payload 中的 `agentId`。
Daemon 通过自身唯一的云端 WebSocket 接收消息，并在本地按 `agentId` 查找 runtime。
连接身份（如底层 transport 的 connection id）仅属于 transport 管理细节。

## 组件与边界

- **Web/backend** 是业务控制面：认证、成员授权、Conversation/Message 持久化、顺序分配和路由决策。Message 是云端 canonical 事实来源。
- **Standalone Centrifugo** 只负责 WSS、发布/订阅、RPC、重连相关 transport mechanics；不理解 Conversation、Agent Activity，也不拥有数据库。
- **Daemon** 是用户机器上的执行协调者，拥有一个 Workspace 云连接和多个 Agent runtime 生命周期；它从云端恢复 Message，并把消息交给正确 runtime。
- **Code-agent adapter** 提供统一的 provider-neutral seam。Daemon 不知道 Claude、Codex、Pi 的具体协议；adapter 自己转换 provider 协议。
- **Agent runtime** 执行任务，不拥有 CoForge 消息可靠性、云端游标或成员 unread 真相。

不要混淆 transport channel、业务 Conversation、Message 和 Agent Activity：channel 是传输范围，Conversation 是私聊关系，Message 是业务事实，Activity 是运行过程诊断。`event_id` 等可以是技术字段，但 “Agent Event” 不是业务消息模型。

## 数据模型

当前模型围绕 `Workspace`、`User`、`UserIdentity`、`Agent`、`Conversation`（当前仅 DirectConversation）、`ConversationMember`、`Message`。DirectConversation 恰有一个 User 和一个 Agent；未来群聊通过扩展 ConversationMember，而不是改变当前私聊语义。

- `User.id` 是 CoForge 内部稳定 UUID。Authing/GitHub 等外部 subject 只存在于 `UserIdentity(provider, providerSubject)` 映射中，业务表不依赖外部 user ID。
- User 和 Agent 都是 `ConversationMember` 的一种，共用聊天、消息历史和 unread 模型；不创建 `AgentUnreadMessage` 或 Agent 专用 unread 表。
- `Message` 至少有 `message_id`、`conversation_id`、`workspace_id`、发送方 member、正文和服务端分配的会话顺序 `conversationSeq`（代码/迁移可能仍处于演进中）。正文是 Markdown/text；附件关系独立建模。
- `ConversationMember` 至少有 subject（User 或 Agent 的 XOR 关系）及通用 `lastReadSeq`/read boundary。它属于云端业务状态，User 与 Agent 均适用。
- Agent 的 `online/offline` 是 presence；`idle/busy` 是 Daemon 内部 runtime 可用性；Agent Activity 是运行过程记录。三者不能互相替代，也不应合并成一个字段。

`AgentMessageDelivery` 是当前已实现的协议传输 payload，不是新的持久化模型；其业务接收目标只有 `agentId`。

## 消息生命周期

1. Web/backend 鉴权发送者，确认其为 active ConversationMember，并校验正文、附件引用及 Workspace scope。
2. 在云端事务中按该 Conversation 的 `conversationSeq` 保存 canonical Message；重试使用发送方稳定幂等键，不能生成第二条业务消息。
3. 提交后通过唯一 `agent` transport channel 通知 Daemon。通知丢失不改变事实：Daemon 重连或恢复时仍以云端 Message 和 sequence 为准。
4. Daemon 校验 Workspace、Conversation、Agent scope，找到该 Agent 的 runtime，并调用 `CodeAgentSession.sendMessage(message)`。
5. Daemon 对自身处理可以记录三阶段语义：`pending` 表示云端已有消息但尚未被 session 接受；`accepted` 表示 session 已接受本地责任；`injected` 表示已向 runtime 调用注入。`accepted` 绝不表示 Agent 执行完成。

### MVP 请求幂等

浏览器首次发送时生成 UUID `request_id`；失败后正文未编辑的重试复用它，成功后的下一条消息或编辑后的失败草稿生成新的 `request_id`。Agent 回复同样复用调用方已有的 `request_id`。Backend 不代替调用方生成该身份，也不把正文、username 或 Agent 名称当作身份。

Web/backend 使用现有 Redis，以 `(workspace_id, sender_kind, sender_stable_id, request_id)` 为 scope。User 与 Agent sender kind 明确分离。首次请求通过 Redis `SET NX EX` 原子取得短 processing claim；并发重复请求得到明确的可重试 processing 错误。claim owner 才能通过 Lua 原子完成或释放 claim，持久化失败会释放当前 owner 的 claim。PostgreSQL Message 持久化成功后，可序列化结果（包括可恢复为 `Date` 的创建时间）在 Redis 保留 24 小时。

PostgreSQL Message 始终是 canonical 数据，Redis 只做 24 小时短期防重复，不承担历史、replay 或永久唯一约束。User→Agent publication 位于幂等持久化之外：publication 失败后以相同 `request_id` 重试会读回同一 Message 并重新发布同一 delivery，而不会再次持久化。

这个 MVP 存在已接受的 Redis/PostgreSQL 双写崩溃窗口：PostgreSQL commit 成功而 Redis 结果尚未写入时，claim 过期后的相同请求可能再次创建 Message。当前实现不声称消除该窗口；关闭窗口需要未来的 PostgreSQL schema/事务性唯一约束决策。

当前不要求把这些阶段做成持久化 delivery ledger。无论将来如何记录，不能在
`CodeAgentSession` 接受前 ACK；transport ACK 也不是 Agent 完成 ACK。

## idle / busy 与未读游标

`active/inactive`（或 online/offline）回答“Daemon/runtime 是否在线”；`idle/busy`
只回答“当前 runtime 是否可接受直接注入”。Daemon idle 时优先低延迟直接注入；busy
或 offline 时不丢弃消息，消息留在云端，待 runtime 空闲或重连后按
`conversationSeq` 恢复。Activity 记录 turn、工具、错误等过程，不改变 presence 或 busy
的定义。

`ConversationMember.lastReadSeq` 是通用成员读取边界。User 和 Agent 都可以有该边界，
但 Agent 不知道、也不负责维护云端游标；Daemon 可以有易失的内存 cursor/cache，只是
优化，不要求本地落盘。恢复依据始终是云端 Message 与 read boundary。这样并不矛盾：
本地服务负责执行协调，云端负责可靠消息和通用成员读取边界。

## Agent 回复链路

Agent 通过本地 `coforge message send --target ...` 能力发送回复。target 使用全站唯一
username，不暴露内部 ID。Daemon 接收并转发请求；Web/backend 解析 target、鉴权发送者
及 Conversation 范围，生成/校验发送方幂等键，在云端保存反向 canonical Message，再按
同一 `conversationSeq` 规则通知其他成员。回复提交失败时应以同一幂等键重试，避免重复
canonical message；这不是把 Agent execution 状态当成消息状态。

## 文件与附件

正文保持 Markdown/text。附件使用 `Attachment`/`MessageAttachment` 结构化关联，保存
attachment identity、provider-independent `object_key`、文件名/类型/大小等 metadata；
文件本体在 private object storage。不得把二进制、附件事实塞进 Markdown，也不得把完整
文件内容直接塞进 JSON。授权下载必须先通过 backend 验证可见的 committed Message，再
由 OSS/CDN adapter 生成短时 opaque URL；signed URL 不写入数据库或日志。

送给 Agent 时由统一 adapter 组装：正文放前，附件信息统一放后。上层不解析 provider
格式，具体 provider 的附件能力和转换留在 adapter 内。

## adapter 边界

Daemon 只依赖类似 `CodeAgentSession.sendMessage(message)` 的 provider-neutral contract，
以及启动、订阅活动、中断、释放等通用能力。Pi/Codex/Claude adapter 自己负责 native
protocol、SDK runner 或 ACP 的转换、错误和能力差异；这些细节不可泄漏到 Web、Centrifugo
或共享业务模型。Agent Activity 跨 transport 时是规范化运行诊断，不是 Message。

## 重启与可靠性

消息先云端持久化，再尝试低延迟通知，因此通知、连接或 Daemon 内存队列丢失都可以通过
按 `conversationSeq` 查询/重放修复。重连时从上次已知位置恢复；重复投递必须以
`message_id`/发送方幂等键抑制，不能要求 exactly-once Agent execution。Daemon 忙或离线
期间，云端 Message 保留待恢复；恢复后按序交给 session。

当前不引入本地 durable spool、数据库 command mailbox、claim/lease 或完整 per-Agent
delivery ledger。若未来故障证据证明需要 durable 接管记录，必须先单独确认字段、ACK
边界、幂等约束和恢复 SLO，不能把 connection-local memory queue 宣称为 durable storage。

## 当前明确不做

- 群聊（未来仅扩展 ConversationMember）；
- Agent 专用 unread/delivery 模型、全局 Agent inbox sequence；
- 把外部身份 subject 当业务外键或暴露内部 ID 作为 target；
- 把 presence、busy/idle、Activity、Message 或 transport channel 合并；
- 本地 durable spool、数据库 mailbox、claim/lease、完整 delivery ledger；
- 把 provider-specific protocol 放进 Daemon 上层或协议/业务模型；
- 把附件二进制塞进正文或 JSON；
- 把 accepted/ACK 描述为 Agent 执行完成。

## 实现前仍需确认的少数问题

1. `conversationSeq` 的并发分配，以及消除 Redis/PostgreSQL 双写窗口所需的最终 Prisma/SQL 唯一约束。
2. 现有版本化 Protobuf 中 delivery/replay/ACK 的精确 envelope，以及 legacy worker 字段的兼容期限。
3. Daemon 内存 cursor 的生命周期、重连时的起始边界和可测量恢复 SLO。
4. `coforge message send` 如何绑定当前 Agent 身份、生成幂等键，并在多条 DirectConversation 中解析 target。
5. Attachment/MessageAttachment 的最终字段与统一 adapter 的附件能力降级策略。

## 参考代码与基线

相关现状见 [`docs/architecture.md`](architecture.md)、[`docs/database-schema.md`](database-schema.md)、`apps/web/prisma/schema.prisma`、`packages/protocol/proto/coforge/rpc/v1/workspace.proto`、Web 的 direct-message use case，以及 Daemon 的 `connection`、`daemon-runtime`、`agent-runtime`、`code-agent/contract.ts`。这些代码显示当前链路仍在实现中，不能反向扩大本文已确认范围。
