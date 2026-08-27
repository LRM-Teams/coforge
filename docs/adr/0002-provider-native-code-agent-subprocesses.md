---
status: accepted
date: 2026-08-27
---

# CoForge Agent 与 Codex 使用常驻独立子进程 adapter

Frank 在 [Amp thread](https://ampcode.com/threads/T-01a040e2-d2ad-70ac-a080-fbabe1561e52) 中批准首批接入 Pi 与 Codex，并明确要求 Agent runtime 使用独立子进程。这个决定替代“所有 code agent 都必须经 ACP”这一未实现假设；workspace worker 对上仍只使用 provider-neutral code-agent interface，provider native protocol 不进入云端 wire、共享领域模型或其他 daemon 模块。

## 问题与约束

Pi 与 Codex 当前都没有正式支持的 ACP server。Pi 正式提供 SDK 和 JSONL RPC mode；Codex 正式提供 app-server JSONL stdio。为了保留进程故障隔离，同时避免让 provider control 选择泄漏到上层，需要固定常驻子进程 ownership，而不把 RPC、SDK child runner、app-server 或 ACP 中任何一个固定为所有 provider 的长期协议。

首个 interface 只固定：创建临时 session、发送 prompt、订阅文本/工具/完成事件、中断和销毁。它不决定云端消息 wire、durable spool、credential lifecycle、Agent session 持久化或 Workspace supervisor。

## 决定

- 每个 Pi 或 Codex session 运行在 workspace worker 启动的独立 Agent runtime process 中，cwd 是声明的 Agent workspace 目录；同一个 process 跨多次 prompt 常驻并复用，直到显式销毁。
- Agent control protocol 只属于 adapter implementation，可以在不改变 `CodeAgentSession` interface 的前提下替换。
- 内置 Pi 实现属于可独立打包的 `@coforge/agent`，不是 daemon 源码中的 provider fork。该 package 固定 Pi SDK 版本，拥有 Pi-specific runner、extensions 和 skills；Daemon 安装精确版本并通过 package 的 `coforge-agent` executable 启动它。
- CoForge Agent child runner 使用 Pi SDK 的 `createAgentSessionRuntime` 创建 in-memory session，并通过 SDK `runRpcMode` 提供 LF-delimited JSON command/response 和异步事件；完成以 `agent_settled` 为准，中断先清空 queue 再 abort。Pi `ResourceLoader` 在 RPC command loop 启动前完成 reload；任何 skill diagnostic 都使启动失败，Daemon 再通过 `get_commands` readiness request 确认资源接口可用。
- 当前 Codex adapter 启动 package 内置的 `codex app-server`，完成 `initialize` / `initialized` 后创建 ephemeral thread；turn 使用 `workspace-write` sandbox 与 `never` approval policy，完成以 `turn/completed` 为准。
- Codex adapter 在创建 thread 前调用 stable `skills/list` 并设置 `forceReload: true`；对应 cwd 缺失或报告 skill loading error 时启动失败。
- 两侧 native envelope、request ID、thread/turn ID、tool item 和 provider error 都留在 adapter 内；调用方只认识 `CodeAgentSession` 与 provider-neutral event。
- 子进程只继承运行所需的基础路径、用户目录、临时目录和 locale 环境；额外变量必须由调用方显式声明。CoForge cloud credential 不得传入 Agent 子进程。
- ACP 仍可用于未来正式支持 ACP 的 provider，但不是统一 seam 本身。

当前 adapter 是 runtime integration seam，不代表 production sandbox 已完成。Pi 的工具和同一 OS user 下的 provider 进程仍需要后续受批准的 filesystem、credential 和 operation 隔离；这些门禁完成前不得把本 adapter 宣称为可执行不受信任 Agent 的安全边界。

## 选型、成熟度与 license

| Candidate | Maturity and compatibility | License | Decision |
| --- | --- | --- | --- |
| Pi SDK 同 workspace worker 进程 | 正式 SDK；package 声明 Node ≥22.19，核心 session path 已在 Bun 1.4 验证 | MIT | 拒绝作为 runtime ownership；故障和内存不与 workspace worker 隔离 |
| `@coforge/agent` SDK child runner | 独立 package 固定 Pi v0.84.3；使用正式 SDK runtime/resource loader/run mode，Bun 1.4 handshake 与 startup skill discovery 已验证 | CoForge package license 尚未决定；Pi 为 MIT | 当前实现 |
| Codex app-server 子进程 | v0.150.1 正式文档化 stdio integration；npm wrapper 声明 Node ≥16，Bun 1.4 handshake 已验证 | Apache-2.0 | 当前实现；可由后续正式协议替换 |
| 自研 ACP bridge | 可保持表面单协议，但需要自行维护完整 capability、event、permission、cancel 与版本映射 | CoForge 自有维护面 | 拒绝；没有弥补 native protocol 的产品收益 |
| 直接解析交互式 CLI output | 输出不是稳定 machine interface | provider dependent | 拒绝 |

`@coforge/agent` 与 Codex package 版本必须作为 Daemon 的精确依赖随 release set 固定并一起验证，不能依赖用户 PATH 中的任意版本。Codex app-server schema 与 binary 同版本演进；当前只使用 stable method，不开启 experimental API。

## 运行、迁移与回滚

初始仓库没有 production Agent adapter、session 数据或 wire consumer，因此不需要数据迁移。增加或删除一个 adapter 只改变 Daemon package 与 release payload，不改变云端 schema。

启动 handshake 失败、stdout 出现无效 JSON、stdin 不可写或子进程提前退出时，adapter 显式失败，不能回退到交互式 CLI parsing。销毁先关闭 stdin 并等待正常退出，超时后发送 SIGTERM；provider stderr 只被 drain，不自动写入可能泄漏 credential 的产品日志。

回滚恢复前一组 Daemon、`@coforge/agent` 和 Codex artifact；不得静默改用 workspace worker 同进程 SDK、自研 ACP bridge 或用户 PATH 中的其他 binary。已运行的 ephemeral CoForge Agent/Codex session 不构成 durable state，rollback 不承担 session migration。

## 验证门槛

- 独立 pack `@coforge/agent`，从安装后的 `coforge-agent` executable 在 Bun 1.4 完成 SDK runner handshake；
- 在 Agent workspace 写入 test skill，验证 CoForge Agent 在接受 RPC command 前已经发现它；
- 使用真实 Codex package 完成 app-server handshake，并验证 `skills/list(forceReload: true)` 发生在 `thread/start` 前；
- 使用真实子进程 fixture 验证 prompt acceptance、text/tool event mapping、completion、interrupt 与 stdin-close shutdown；
- 验证未声明环境变量不进入 Agent 子进程；
- format、lint、typecheck、test 与 compiled Daemon build 通过。

## 一手资料

- Pi [SDK](https://pi.dev/docs/latest/sdk)、[RPC mode](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/rpc.md)、[package metadata](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/package.json) 与 [MIT license](https://github.com/earendil-works/pi/blob/v0.84.3/LICENSE)
- Codex [app-server documentation](https://developers.openai.com/codex/app-server)、[app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)、[protocol schemas](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/typescript) 与 [Apache-2.0 license](https://github.com/openai/codex/blob/main/LICENSE)
- Bun [child processes](https://bun.com/docs/runtime/child-process) 与 [Node.js compatibility](https://bun.com/docs/runtime/nodejs-compat)
