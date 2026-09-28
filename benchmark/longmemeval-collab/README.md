# LongMemEval Group-Chat Collaboration Eval (coforge + openviking)

参照 `OpenViking/benchmark/longmemeval/openviking`（import → retrieve → answer → judge → stat
by question type）的测试方法，把问答搬进 coforge 群聊的产品链路，测**群聊里的多 Agent 协作**：
Memory Agent 只负责检索，Task Agent 消费检索结果并对用户作答。

## 拓扑（每个样本一个一次性 workspace + 一次性 OV 账号）

频道成员：

| 成员 | 角色 |
| --- | --- |
| `user`（人类） | LongMemEval 的用户侧；haystack 里 `user` 轮的历史消息由它发出；提问者 |
| `task`（Task Agent） | 应答者；haystack 里 `assistant` 轮的历史消息由它发出（single-session-assistant 题考的就是它说过的话）；普通 toolset（频道读写，无记忆工具） |
| `memory`（Memory Agent） | 只检索；openviking-memory fence（ov_find / ov_read / memory_offer） |

## 协作链（被测机制）

1. 灌库：haystack session 逐个插入频道（时间按 `haystack_dates` 回填），走产品自身的
   quiet-window → Admitted PublicChannel Segment → OpenViking typed-session sink。
2. 提问：用户发 `@memory <question> (Today's date: YYYY-MM-DD)`——directed delivery 只唤醒
   Memory Agent（日期随问题发出，对齐 OV 基准 answer prompt 的 question_date 约定）。
3. 检索：Memory Agent `ov_find`/`ov_read`，然后 `memory_offer` 发布带引用的 Memory Offer。
   模型不指定投递目标时，产品按 `resolveUnansweredMemoryOfferTarget` 把 offer 路由给频道里
   最近的显式提问对应的 peer agent —— 即 Task Agent。
4. 交接：offer 以 `@task` mention 的频道消息发布，唤醒 Task Agent。
5. 作答：Task Agent 读取 offer + 频道上下文，在频道回答用户。判分对象是它的回答。

为什么不让 Task Agent 主动 `@memory` 委托：`resolveUnansweredMemoryOfferTarget` 只认
**人类**发出的显式提问（`sender.userId != null`），agent 发的 `@memory` 无法解析默认投递
目标，而模型拿不到 peer 的 UUID。用户提问 → offer 路由给 peer 是当前产品支持的完整协作链。

## 机制判据（mechanism）

| 判据 | 含义 |
| --- | --- |
| `ok` | offer 存在、citations ≥ 1，Task Agent 在 offer 后作答 |
| `no_offer` | Task Agent 作答但没有 offer（会话里没有历史，属无依据作答） |
| `uncited_offer` | offer 无引用 |
| `leak` | Memory Agent 在 offer 之外又发了频道消息（send_channel_message 泄漏面） |
| `no_reply` / `timeout` | Task Agent 未作答 / 整链超时 |

headline = mechanism `ok` 且 judge=CORRECT。

## 判分

Task Agent 的最终回答（settle 窗口内最后一条消息）对比 gold answer，使用
`OpenViking/benchmark/longmemeval/openviking/longmemeval_prompts.py` 的**宽松 JUDGE_PROMPT
逐字移植**（`<judge_thinking>` 后裸 yes/no），由 Cursor CLI（默认 grok-4.6，与两个 agent
的模型不同）执行。输出按 question_type 分组统计。

## 数据

`longmemeval_s.json`（500 样本 × 1 题，6 题型；每样本 ~44–53 个 haystack session）。
sha256 pin（loader 支持传入）：`08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894`。

分层 30 样本（每题型 5 个）索引：

```
COFORGE_EVAL_SAMPLES=0,1,2,3,4,70,71,72,73,74,132,133,134,135,136,233,234,235,236,237,366,367,368,369,370,444,445,446,447,448
```

## 运行

前置与 public-channel eval 完全一致：web(:8788)+redis+centrifugo+Postgres 在跑，OpenViking
docker 已起且带 `--cpuset-cpus=0-1`（多线程 embed 退化问题的修复），`apps/web/.env`、
`~/.pi/agent/models.json`、cursor key、OV conf 就绪。

```bash
cd benchmark/longmemeval-collab
COFORGE_LME_COLLAB_EVAL=1 \
DATABASE_URL=... REDIS_URL=... CURSOR_API_KEY=... \
COFORGE_EVAL_SAMPLE_INDEX=0 \
bun src/run.ts            # smoke：样本 0
```

主要环境变量（`src/env.ts`）：

- `COFORGE_EVAL_SAMPLES`：逗号分隔的样本索引（0 基，数据集序）；或 `COFORGE_EVAL_SAMPLE_INDEX` + `COFORGE_EVAL_SAMPLE_COUNT`
- `COFORGE_EVAL_POLL_TIMEOUT_MS`（默认 300000，两跳链路比 pcm 的 180s 长）、`COFORGE_EVAL_SETTLE_MS`（默认 15000，Task Agent 静默窗口）
- `COFORGE_EVAL_INGEST_FROM_SESSION`：断点续灌（默认 1）
- `COFORGE_EVAL_OV_ACCOUNT`：复用账号（续跑）；复用时**不要删账号**
- `COFORGE_EVAL_DATA_PIN`：数据集 sha256 pin
- agent 模型：`COFORGE_EVAL_MEMORY_AGENT_PROVIDER/MODEL`、`COFORGE_EVAL_TASK_AGENT_PROVIDER/MODEL`（默认 Pi `lenovo-deepseek-v4-flash`/`DeepSeek`）

结果落在 `result/attempts-*.jsonl` + `summary-*.txt`（含每题型 headline）。

已知沿用 pcm 的怪癖：prisma `$disconnect` 在写出结果后可能挂起，由外层 watchdog 在看到
`wrote .../attempts-` 日志后 pkill；SIGTERM 可能留下 workspace/binding，复用账号前先查
`openVikingBinding` unique(accountId) 是否被残留 workspace 占用。

## 与两条既有基线的关系

- `benchmark/public-channel-memory`（LoCoMo）：单 agent 视角——@memory 直接问 Memory
  Agent，判它的 offer 文本。本基准判的是**第二个 agent 基于 offer 的回答**，多了 offer
  唤醒 → 阅读上下文 → 组织答案这一整段协作。
- `OpenViking/benchmark/longmemeval/openviking`：直连 OV 客户端 find/read + 外部 VLM 拼
  prompt 作答。本基准同数据集、同判分 prompt，但作答走 coforge 群聊产品链路。
