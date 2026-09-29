# OpenViking 频道记忆

写线把已关闭的公共频道分段交进 OpenViking typed session。读线仍是 Memory Agent fence（`ov_find` / `ov_read` / `ov_search_context` / `memory_offer`，预算 3 次读 + 1 次 offer）。本文件只描述写线。

## 两层 session 模型

两层 session 不是同一种东西。

- Agent session 是运行时收件箱。Daemon 拥有它，用来把频道投递交给正在跑的 agent。它不写入 OpenViking。
- OV session 是一条频道分段。分段在 quiet-window 或 completed-task 关闭之后，整段 `POST /messages/batch`，再 `POST /commit`（`keep_recent_count: 0`）触发抽取。一个分段一个 session，id 为 `coforge-<segmentId>`。

不按 agent 建 OV session。定向投递使 agent session 成为频道日志的有损子集：没投递给它的消息它看不到，而它自己的收件箱又会跨频道混在一起。按 agent 复制会得到 N 份拷贝，抽取窗口永远对不齐。

## 借鉴 hermes 的决策

对照的是 hermes 的 session sync，不是它的整条管线。commit 仍然只在分段关闭时发生。

| 项 | 本次 | 原因 |
| --- | --- | --- |
| B1 两阶段 | 借 | append 与 commit 分成可观测阶段：`append_submitted`、`append_settled`、`commit_submitted`、`commit_settled`。事件带 `segmentId`、`sessionId`、`messageCount`、`elapsedMs`，默认打一行 JSON（`workspace_memory_session.phase`）。 |
| B2 回显剔除 | 借 | Memory Offer 的引用块不再二次入库。正文在第一条含 `viking://` 的行处切开，前面留下，并标 `derived: true`。切完没有正文时写入 `[memory offer — 结论:无独立结论;引用内容不入库]`。原始人类消息仍按原文摄取。 |
| B3 崩溃补交 | 借 | `pending` 超过 10 分钟才重推。常量 `WORKSPACE_MEMORY_PENDING_REDRAIN_AFTER_MS`，可用同名 env 覆盖。年龄看 dispatch 行已有的 `updatedAt`。`retryable_failure` 仍立刻重推。`ingestOperationId` 与 `AdmissionReplayConflictError` 不变。 |
| B4 peer | 借 | agent turn 写成 `role: assistant`，并带 `peerId: coforge__<senderHandle>`（batch 字段 `peer_id`）。human turn 不带。 |
| B6 逐条降级 | 借 | batch POST 失败时改为逐条 `POST /messages`。逐条也失败才返回 `retryable_failure`。 |
| turn-slice | 不借 | 只保留被 @ 到的消息会丢掉同段里其余发言。分段仍是整段频道窗口。 |
| per-agent session | 不借 | 见上一节。定向投递是有损子集加跨频道混流。 |
| B5 trajectory | 不借，将来 | Daemon 以后收割 agent session transcript（含 tool calls），写入 OV trajectory。联邦场景（外部独立安装的 agent）另记，不在这条频道写线上做。 |

Append 幂等：batch 之前 `GET /sessions/{id}`，用已有消息的 `source_message_ids` 判断。目标消息都在，就跳过 batch，直接 commit。GET 失败则仍走 batch，避免探测故障挡住第一次写入。

## Capability 矩阵

点亮验证只填写已经存在、并且本次相关测试通过的用例。路径相对 `apps/web/`。

| 能力 | hermes | coforge 首版前 | 首版后 | 点亮验证 |
| --- | --- | --- | --- | --- |
| 会话摄取 | 有 | 有：batch 后 commit | 有，并带阶段事件与 peer | `src/server/openviking/typed-session-extract.server.test.ts`「typed session extract writes the session then commits then extracts with server-held credentials」；`src/server/workspace-memory/ov-sink.server.test.ts`「OV sink delivers through the typed channel and retries as retryable_failure」 |
| B1 两阶段 | 有 | 调用顺序在，阶段不可观测 | 四个 phase 按序发出，commit 一次 | `src/server/openviking/typed-session-extract.server.test.ts`「typed session extract reports append and commit phases in order around one commit」 |
| B2 回显剔除 | 有 | 无，offer 原文入库 | offer 去掉 `viking://` 之后的引用，标 `derived` | `src/server/workspace-memory/sweep.test.ts`「an offer message is written without its citation text and the human message stays verbatim」 |
| B3 崩溃补交 | 有 | 下一轮 sweep 会重推全部 pending 与 retryable_failure，不看年龄；append 不幂等；batch 失败即失败 | 超过 10 分钟的 pending 才重推；已 append 则只 commit；batch 失败逐条 POST | `src/server/workspace-memory/sweep.test.ts`「a pending dispatch older than ten minutes is redriven by the next sweep」；`src/server/openviking/typed-session-extract.server.test.ts`「a replay after the append lands and the commit crashes does not append those messages again」；同文件「a failed message batch falls back to one post per message and still commits」 |
| B4 peer 归属 | 有 | assistant 无身份 | `coforge__<handle>`，human 不带 | `src/server/workspace-memory/ov-sink.server.test.ts`「agent turns carry a coforge peer id and human turns do not」 |
| fence 读线 | 单闸门读，不是每 agent 一套写入 | 有，profile 级 fence | 不变 | `src/server/workspace-memory/memory-agent-fence.test.ts`「maps Workspace Memory Profile to the injected Memory Agent fence」；同文件「store lookup returns the fence without exposing profile selection to callers」 |
| 每 agent viking_* 工具 | 不在本次对照里单列 | N/A：读线单闸门 | N/A：读线单闸门 | 同上 fence 用例。没有 per-agent 工具面可点亮 |
| add_resource、forget | 未纳入本次借用 | ⬜ 后补 | ⬜ 后补 | 未点亮 |

## Open questions

- B5 trajectory 线：daemon 收割 agent session transcript（含 tool calls）写入 OV trajectory，以及联邦场景下外部独立安装的 agent。现在没有写线。
- `add_resource` 与 `forget` 仍是后补，写线和读线都不提供。
