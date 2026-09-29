# HANDOFF — CoForge PublicChannel 群聊记忆评测

日期：2026-09-22。读这一篇即可接着跑，不必重 grill。

前序 OV+CM 实施 handoff 仍在 `/tmp/handoff-ov-cm-implementation.md`（F6/F7、两个 worktree、不 commit / 不碰 AGPL）。本文只覆盖**群聊评测**。

会话记录：`/home/zhoujie22/.cursor/projects/home-zhoujie22-river2-0/agent-transcripts/fc54b513-119b-485b-a356-1082c7655849/fc54b513-119b-485b-a356-1082c7655849.jsonl`

---

## 0. 先看这个：磁盘和会话不一致

评测包 **HEAD 是骨架**（commit `28d6dd88`，分支 `feat/ov-cm-implementation`）。约 03:33 工作区被还原到 HEAD。`git status` 干净。

会话里写过、**现在磁盘上已经没有**的文件：

| 丢失 | 作用 |
|---|---|
| `src/eval-daemon.ts` | 为 disposable Workspace 注册 Computer、进程内 `DaemonRuntime`、隔离 Pi host、产品 `AgentControl.start` |
| `src/causal-host.ts` | `:9938` 不通时拉起 `causal-memory http`，写一次性 `token → workspaceId` JSON |
| `test/causal-host.test.ts` | 因果 host 单测 |
| `packages/agent` / `packages/daemon` 上的 `COFORGE_EVAL_DISABLE_HOST_PI_INJECTION` | 评测启动的**所有**频道 Agent 关闭 Pi 自己的 MEMORY.md / host skills / assigned skills |

会话里改过、**已回到 HEAD 旧语义**的文件：`src/{env,run,workspace,judge}.ts`、`README.md`、`test/{env,judge}.test.ts`。

不要以为当前 `run.ts` 还会起 daemon。它只建 Workspace、灌库、发 `@memory`、轮询，**假定外面已经有一台绑了这个 Workspace 的 daemon**。那条路径活评测证明走不通（见 §5）。

---

## 1. 这是什么 / 不是什么

**是**：CoForge 产品路径上的 PublicChannel 记忆评测。LoCoMo 历史写成频道 Message → quiet window（15min）或完成任务 → Admitted PublicChannel Segment → OpenViking / Causal Memory → 用户 `@memory <question>` → Memory Agent 只读检索 → Memory Offer（带 citation）给频道里一个活跃 Agent。

**不是**：

- OpenViking `vikingbot --group-chat`
- `evol_bench/LoCoMo` runner
- F6 合成烟测（仍独立）
- DirectConversation（永不 admitted）

评测活在 CoForge worktree，不在 OpenViking 仓库。OpenViking / causal-memory 上游只读。默认 CI 不跑（opt-in `COFORGE_PUBLIC_CHANNEL_MEMORY_EVAL=1`）。未要求不要 commit，不要碰 AGPL/shipping。密钥不进 argv / 日志。

---

## 2. 已冻结的 grill 决定（不要重问）

| 项 | 决定 |
|---|---|
| 评测放哪 | CoForge `cursor-ov-cm-impl` worktree，`benchmark/public-channel-memory/` |
| Q4 | **B**：完整 `@memory` → Memory Offer 产品路径 |
| Q5 | **B**：两臂 `openviking` 然后 `causal_openviking` |
| 数据 | `evol_bench/LoCoMo/data/locomo/locomo10.json`，pin `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` |
| sample | `conv-26` |
| 题目 | 类别 1–4 前 6 题，跳过类别 5 |
| Headline | 频道回复 + 带 citation 的 Memory Offer + 用过记忆工具（或 citation 可证）+ judge=CORRECT |
| leak | 只靠 `message_read` / 频道正文 → `leak`，不进 headline。`message_read`-only 即使有 citation 也算 leak |
| Judge | Cursor CLI：`agent -p --mode ask --sandbox enabled --trust`，模型 **`grok-4.6`**（不是 composer） |
| Memory Agent | Pi DeepSeek：provider `lenovo-deepseek-v4-flash`，model `DeepSeek`（网关 id；响应模型名为 `DeepSeek-V4.1-Flash`）。产品 `runtimeConfig` 走 COFORGE + 加密 key（`~/.pi/agent/models.json` 里那份），不是空 `{}` |
| 评测期 Pi 注入 | **关**。Memory Agent 和群聊里其他 Agent 都不读 `~/.pi/agent/skills`、不灌 `MEMORY.md`、不装 assigned skills。记忆只走 Memory Agent fence 工具 |
| 每臂 | 独立 disposable Workspace + OV account + 一条 PublicChannel |
| 灌库 | Memory Agent 必须离线（`computerId: null`），QA 前再挂 Computer / Start |

其余 grill 项按当时推荐。

---

## 3. 磁盘上现在有什么（HEAD 骨架）

目录：`/home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl/benchmark/public-channel-memory/`

| 文件 | 现状 |
|---|---|
| `src/types.ts` `locomo.ts` `locomo-time.ts` `sanitize.ts` `ov.ts` `ingest.ts` `eval-qa.ts` `leak.ts` `report.ts` | 可用。`eval-qa` 用 `PublicChannels.send` 发 `@memory`，轮询 Memory Agent 消息或 `memoryOfferRecord` |
| `src/env.ts` | 仍要求 `COFORGE_EVAL_JUDGE_BASE_URL` / `JUDGE_API_KEY` / `JUDGE_MODEL`。**没有** Cursor CLI、没有 DeepSeek 默认、没有 `webUrl` 作为必填运行时依赖的完整形态 |
| `src/judge.ts` | 仍是 OpenAI 兼容 HTTP judge，不是 `agent` CLI |
| `src/workspace.ts` | 创建时就把 Memory/Task Agent 的 `computerId` 指到一个**未注册、无 daemon** 的 Computer；`runtimeConfig: {}` |
| `src/run.ts` | 无 causal host、无 eval daemon、无 `AgentControl.start` |
| `test/` | locomo / leak / env / judge。缺 causal-host、process-manager 评测相关断言 |
| `package.json` | workspace `@coforge/public-channel-memory-eval`，有 `@prisma/adapter-pg`。不要加 `test` script（避免默认 CI 拉真 OV/LLM） |

`eval-qa.ts` 的产品事实仍然对：有 `REDIS_URL` 才走 `PublicChannels.send`（Centrifugo 投递）；否则只写 DB，daemon 收不到。

---

## 4. 会话里已经验证、重建时必须保留的产品事实

### 4.1 消息不会 Start Agent

ADR 0038：Message / task / reminder **只发 delivery，不发 Start**。

`DaemonRuntime.handleAgentMessage`：没有 running session 且 `restartConfig` 为空 → `Error("Agent is inactive")` → 日志 `agent_runtime:message_delivery_failed`。

因此 QA 前必须走产品 `AgentControl.execute({ action: "start" })`（或 UI Start）。本地直接 `runtime.handleAgentStart` **不行**：server 没 `begin()`，没有授权 epoch/launchId，session snapshot 一定 403。

灌库时 Agent 的 `computerId` 必须是 `null`，否则 daemon ready 会走 recovery，经 8789 拉 session，503/403。QA 前再 `register` Computer、`runtime.start()`、再 `agent.update({ computerId })`。

### 4.2 Session snapshot 走 Centrifugo RPC → **8789**，不是 18888

本机栈：

| 端口 | 是什么 |
|---|---|
| `:1933` | OpenViking，`/health` 200 |
| `:5432` | Postgres（评测和 coforge **同一库**） |
| `:16379` | CoForge Redis（不是 `:6379`） |
| `:18000` | Centrifugo。RPC 反代到 **8789** |
| `:8788` | `/home/zhoujie22/river2_0/coforge` 的 `bun .output/server/index.mjs` |
| `:8789` | coforge same-origin-proxy（daemon session/control ACK 打这里） |
| `:18888` | **本 worktree vite**（daemon `serverHttpUrl`、memory tool HTTP）。写本文时 **已挂** |
| `:9938` | 评测因果臂默认。本机常年没人听 |
| `:19938` | 已有一条 host-run `causal-memory http`（别的用途，不要当评测默认） |

`dev-memory-daemon`（coforge 树）绑的是库里第一个 Workspace，**看不见** disposable 评测 Workspace。必须进程内 `DaemonRuntime`。

共享库已执行过（不要 `migrate deploy`，库里有本 worktree 没有的 learned_skill migration）：

- `20260921083000_causal_memory`
- `20260921090000_causal_offer_and_citation_display`
- `20260921120000_workspace_memory_profiles`

### 4.3 密钥怎么带（不要 echo）

从 `/home/zhoujie22/river2_0/coforge/apps/web/.env` source：

- `DATABASE_URL`
- `REDIS_URL`（必须是 `16379` 那条）
- `COFORGE_CENTRIFUGO_API_URL`
- `COFORGE_CENTRIFUGO_API_KEY`
- `COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY`

`CURSOR_API_KEY` 曾落到 `/tmp/pcm-cursor-api-key.env`（mode 600）。Judge CLI 是 `~/.local/bin/agent`（不是 `cursor agent`，那个是双 `agent`）。`agent` 已 login。

Pi DeepSeek key 只从 `~/.pi/agent/models.json` 的 `lenovo-deepseek-v4-flash.apiKey` 读，加密后写入 Agent `runtimeConfig.provider.apiKey`。

因果 tenant：`tenantId = workspace.id`。`infra/secrets` 里那份 tokens 是 33 字节非 JSON，**不能复用**；评测自己写 `{ [token]: workspaceId }`。

### 4.4 重建 eval-daemon 时的要点

1. `COFORGE_EVAL_DISABLE_HOST_PI_INJECTION=1`（`packages/agent/src/runner.ts` 的 `resourceLoaderOptionsForSession` → `noSkills/noContextFiles/noExtensions`；`packages/daemon/.../agent-process-manager.ts` 跳过 `seedAgentMemory` + `installAssignedSkills`）。评测启的每个 Agent 都要，不只 Memory Agent。
2. 隔离 Pi host：`/tmp/pcm-daemon-<ws8>/pi-host/`，复制 `models.json`，`settings.json = { skills: [] }`，`PI_CODING_AGENT_DIR` 指过去。`.builtin-runtime` 同样。
3. `serverHttpUrl = COFORGE_WEB_URL`（18888）。Centrifugo WS 默认 `ws://127.0.0.1:18000/connection/websocket`。
4. **不要**在 `runtime.start()` 之后调 `handleAgentStart`。
5. `resetMemoryAgentSession` **只**清 `currentSessionId`。写 `runtimeSession: null` 会变成 JSON null，`AgentControl` 的 JSONB CAS（`Prisma.DbNull`）三次全 miss → `Agent control could not begin after 3 compare-and-swap attempts`。
6. 然后 `new AgentControl(PrismaAgentControlStore, createCentrifugoServerApi(), getAgentRuntimeLock(), { timeoutMs: 90_000 }, createAgentSessions, getAgentControlSignal(), PrismaDirectConversationRepository).execute({ action: "start", userId: evalUserId, ... })`。拼法和 `apps/web/src/features/agents/agent-control.functions.ts` 一样。
7. `ComputerRegistrar.register` 会 upsert `workspaceComputer`；没有这条关联，`PrismaAgentControlStore.get` 直接 `undefined`。

Judge 重建：`gradeReply` 调 `agent -p --mode ask --sandbox enabled --trust`，空临时 workspace，模型 `grok-4.6`，key 只走环境变量。Judge 模型和 Memory Agent 模型必须不同。

---

## 5. 活评测结果（到 03:30 为止）

单元测试曾绿过（约 43）：eval 14 + process-manager + ov-memory-tools。文件还原后这个数字作废，需重跑 `bun test benchmark/public-channel-memory/test`。

活跑：

| 轮 | 现象 |
|---|---|
| 无 daemon / 旧 daemon | 对不上 disposable WS |
| 先挂 computerId 再 `runtime.start()` | ready 在 `agent_recovery` 503（经 8789） |
| 本地 `handleAgentStart` | session snapshot 403 |
| 只挂 Computer、等 `@memory` 唤醒 | daemon 连上；`message_delivery_failed`（Agent is inactive）；`q0`/`q1` `mechanism=timeout judge=WRONG` |
| 产品 `AgentControl.start`（最后一轮） | CAS 修好后 Start **发到了 daemon**。session report **反复 403**，launch retry 6 次，90s 后 `Memory Agent start pending` |

最后一轮证据（workspace `b087bf66-...`，agent `309544f7-...`，computer `01d49988-...`）：

`/tmp/pcm-daemon-b087bf66/logs/daemon/daemon.jsonl`

```
daemon_connection:connected
daemon_ready:completed  running_agent_count=0
agent_session:report_failed  error_code=403   （03:29:10 起，退避 1s→30s，至少 6 次）
agent_control:launch_retry_scheduled
agent_runtime:start_failed
```

8789 把所有 snapshot 收成同一句：`Agent Session snapshot is not authorized`。真实原因在 8789 日志的 `agent_session:snapshot_rejected.reason`（allowlist 见 `apps/web/src/server/centrifugo/agent-session-receiver.server.ts`）。**还没去翻 8789 日志。**

`execute()` 的 ACK 也走 8789 → 共享 Postgres / Redis signal。snapshot 一直 403，所以 phase 停在 `starting`，评测看成 `pending`。

---

## 6. 当前机器状态（写文档时）

- OV `:1933` 健康
- Postgres / Redis 16379 / Centrifugo 18000 / coforge 8788 / proxy 8789：在听
- worktree vite **18888：挂了**。需要的话：

```bash
export PATH="$HOME/.local/share/mise/installs/bun/1.4.2/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl/apps/web
set -a
eval "$(
  grep -E '^(DATABASE_URL|REDIS_URL|COFORGE_CENTRIFUGO_API_URL|COFORGE_CENTRIFUGO_API_KEY|COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY)=' \
    /home/zhoujie22/river2_0/coforge/apps/web/.env
)"
set +a
export OPENVIKING_PROTOTYPE_ENABLED=1
exec bun --bun vite dev --port 18888 --host 127.0.0.1 --strictPort
```

- `/tmp/pcm-*` 残留 daemon 目录和 keyfile 还在
- 用户 `:18788` vite 曾卡住，不要用
- 没有正在跑的 `benchmark/public-channel-memory/src/run.ts`

---

## 7. 下一步（按顺序）

1. **从会话重建丢失代码**（§3/§4），不要从 HEAD `run.ts` 直接开活评测。
2. **查 403 的 reason**：8789 进程日志里 `agent_session:snapshot_rejected`。对照 `authorize` / `sessions.verify` / `receiver.accept`。
3. **让 session ACK 打到写 `controlState` 的那份 Web**。候选（未拍板）：
   - 把 Centrifugo RPC 反代从 8789 改到 18888（影响整机，先确认）
   - 或评测用的 Start/ACK 全部走 18888，且 daemon 的 session RPC 也能到 18888
   - 不要再走「本地 handleAgentStart」捷径
4. Start `phase === completed` 之后再发 `@memory`。先跑 `COFORGE_EVAL_QA_LIMIT=1` 看 q0 是否不再 timeout。
5. 再开两臂 6 题。因果臂：`:9938` 不通就用丢失的 `causal-host.ts` 拉 debug binary `/home/zhoujie22/river2_0/causal-memory/target/debug/causal-memory`（`causal-memory http --help` 会直接起 server，会挂）。
6. 用户没要求就不要 commit。

活跑命令骨架（密钥 source，不要 echo）：

```bash
cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl
set -a
eval "$(
  grep -E '^(DATABASE_URL|REDIS_URL|COFORGE_CENTRIFUGO_API_URL|COFORGE_CENTRIFUGO_API_KEY|COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY)=' \
    /home/zhoujie22/river2_0/coforge/apps/web/.env
)"
. /tmp/pcm-cursor-api-key.env
set +a
export COFORGE_PUBLIC_CHANNEL_MEMORY_EVAL=1
export COFORGE_WEB_URL=http://127.0.0.1:18888
export OPENVIKING_PROTOTYPE_ENABLED=1
export COFORGE_EVAL_ARMS=openviking,causal_openviking
bun benchmark/public-channel-memory/src/run.ts
```

---

## 8. 约束（沿用）

- 回复简体中文
- 不 commit、不 push，除非用户明确说
- 不碰 AGPL / shipping
- OpenViking 仓库只读
- 密钥不进 argv、日志、handoff 正文
- 不发明隐喻；PublicChannel / Admitted Segment / Memory Offer / leak / headline 用产品词
)

## 多 agent 群聊评测（2026-09-23~25）挖出的产品/接线问题

1. **多 agent fence 403**（已修，`packages/agent/src/runner.ts`）：Pi 会话与 daemon 同进程，第二个 agent 启动会用全局 `Bun.env.COFORGE_AGENT_CONTEXT` 覆盖第一个的上下文 → memory fence 全部 403。修复：proxy env 改为 session env 闭包。
2. **托管 reset-session 丢 fence**（未修，评测侧绕过）：server 重建的 start intent 不带 toolProfile；evolbench run.ts 用 stop → 清 currentSessionId → 带 fence 的 startAgent 绕过。
3. **OV keys 统一**：所有评测必须把账号 keys 写到 `/tmp/pcm-eval-ov-keys.json`（web app 的 resolveAuthorization 读这个文件），否则报 "OpenViking runtime is unavailable"。
4. **模型工具参数格式烧预算**：limit 传字符串、编造 operationId、裸 viking:// URI；client 已加 coerce，预算不返还仍是产品问题（evo warm no_offer ~50%）。
5. **skillsbench lane 教训**：runner 任务选择靠 `COFORGE_EVAL_TASKS` env，不传则永远只跑第一个任务。
6. **SF cold shard 教训**：sfcold 分片必须带 `COFORGE_EVAL_VERIFY_SIDECAR` + `COFORGE_EVAL_ENV_NOTE`，否则产出不可验证的行。

### 结论快照（2026-09-25）
- LoCoMo 10/10 样本 ~85%，0 泄漏。
- EvoAgentBench（官方 LCB 判分，全集口径配对 n=86）：warm:test 61.6% vs cold:test 54.7%，**transfer gain +7.0pp**（10 胜/4 负）；warm:train 92.9%。
- SkillLearnBench：配对集 64/64 结果完全一致——群聊记忆对 SLB 结果零效应；曾见的 warm 49% vs cold 62% 是判分覆盖面偏倚假象。
- SkillFlow：warm 11 个独有胜、0 个独有负（跑完后再出最终数）。
