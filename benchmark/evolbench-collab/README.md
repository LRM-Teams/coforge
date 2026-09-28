# evol_bench × coforge 群聊协作评测（七基准统一 runner）

把 `evol_bench/` 的五个基准——**EvoAgentBench / AgentStream / SkillLearnBench / PAST-Bench /
EarthBench**——以及后续接入的 **LifelongAgentBench**（arXiv 2505.11942）和 **SkillFlow**
（arXiv 2604.17308）搬进 coforge 群聊产品链路，测「经验沉淀 → @memory 检索 → 协作执行」这条
自进化回路。前五个消费 evol_bench 现成 manifest；后两个由 `adapters/` 从官方上游数据生成同
schema 的 manifest（不重新发明判分）。

## 群聊协议映射（与 GMS 时代 runner 的对照）

| evol_bench 原协议 | coforge 群聊协议 |
| --- | --- |
| family → Room + Shared/Private Space | family → 一个 workspace + 频道 + task/memory 双 agent |
| episode = fresh Pi 进程（上下文=recall+prompt） | episode 间对两个 agent `reset-session`（stop+clear+start），上下文=offer 召回+prompt；频道历史可读是产品自身行为，记为协议差异 |
| episode 后 evidence drain → GMS | episode 后 harness 显式 drain：新频道消息 → quiet-window 检测（短窗口，已沉淀判定幂等）→ Admitted Segment → OpenViking |
| pre-turn Recall 注入 | `@memory <prompt>` → memory agent ov_find/read → 带 citation 的 Memory Offer 路由给 task agent（mention 唤醒） |
| warm 臂：全量按 order，记忆跨 episode | 同：一个 workspace 跑完 family 全部 episode，OV 账号随 workspace 累积 |
| cold 臂：fresh tenant 只跑 test split | 同：每个 test episode 全新 workspace + 全新 OV 账号（零状态） |
| final_output = room_send 发布 | final_output = task agent 最后一条频道消息 |

判分不移植：runner 产出与 evol_bench python grader 兼容的 `attempts.jsonl`（join on
episode/task id，读 `final_output`），用它们已 pin 的 grader 离线判分（见下）。

## 五个基准的默认 manifest 与判分对接

| 基准 | manifest（默认） | 规模 | grader（离线 python） |
| --- | --- | --- | --- |
| evoagentbench | `evol_bench/EvoAgentBench/data/evo-code-implementation.jsonl` | 268 ep（182 train/86 test） | `PYTHONPATH=evol_bench/multica_test_runner/src python3 evol_bench/EvoAgentBench/code/grading/grading.py --attempts <attempts.jsonl> --manifest <manifest> --lcb-python evol_bench/EvoAgentBench/code/vendor/lcb-venv/bin/python --bridge .../lcb_grade.py --output-dir <dir>`（快照版，REPRODUCE.md 口径） |
| agentstream | `evol_bench/AgentStream/data/agentstream-{isolated,sequential,interleaved}-seed1.jsonl` | 50 ep ×3 场景 | `python3 evol_bench/AgentStream/code/agentstream_grading.py --attempts ... --manifest ...` |
| skilllearnbench | `evol_bench/SkillLearnBench/data/slb-full.jsonl` | 95 ep / 19 family | `python3 evol_bench/SkillLearnBench/code/skilllearnbench_grading.py --attempts ... --manifest ... --sidecar-url http://127.0.0.1:8732`（需 Docker env sidecar） |
| past_bench | `evol_bench/PAST-Bench/data/past-notes-memory.jsonl` | 55 ep / 7 family | `PYTHONPATH=... python3 evol_bench/PAST-Bench/code/past_grading.py --attempts ... --manifest ...` |
| earthbench | `evol_bench/EarthBench/data/eb-smoke.jsonl` | 4 ep（smoke） | `python3 evol_bench/EarthBench/code/earthbench_grading.py --attempts ... --manifest ...` |

headline 指标沿用各 grader 的 `memory_gain_warm_minus_cold` / `delta_warm_minus_cold` /
`test_gain`；本 runner 的 summary 额外给机制列（recall_offered / mechanism_fail / leak）。

## 已知边界（v1）

- **执行环境型任务**（SkillLearnBench 的 Docker 容器、EarthBench 的 104 个 MCP 工具）：
  manifest prompt 里的 run_command/工具约定需要配套 sidecar（`skillsbench_env_server.py`
  / `earthbench_env_server.py`）才可真实执行——task agent 有 shell，可通过 curl 调 sidecar，
  smoke 时补一段 sidecar 地址说明进 prompt 即可；文本型任务（LCB 代码、BFCL 调用列表、
  PAST 文本、EarthBench MCQ）开箱即跑。
- evoagentbench 单 family 268 episode × 双臂是 ~15-20h 级别，先 smoke（`COFORGE_EVAL_FAMILIES`
  + 少量 episode 的 smoke manifest，如 `evo-code-smoke6.jsonl`、`slb-smoke.jsonl`、
  `past-sm01.jsonl`、`eb-smoke.jsonl`、`agentstream-interleaved-smoke.jsonl`）。
- warm 臂 episode 闭包用 `reset-session`；频道历史对 task agent 可读（产品行为），
  warm=channel+OV 全栈、cold=零状态，报告需注明这一口径差。

## 运行

前置同 sibling 评测（web/redis/centrifugo/PG/OV docker+cpuset、apps/web/.env、models.json）。

```bash
cd benchmark/evolbench-collab
COFORGE_EVOLBENCH_COLLAB_EVAL=1 \
DATABASE_URL=... REDIS_URL=... \
COFORGE_EVAL_MANIFEST=/home/zhoujie22/river2_0/evol_bench/PAST-Bench/data/past-sm01.jsonl \
COFORGE_EVALUATION_ID=past-sm01-collab-1 \
bun src/run.ts
```

主要环境变量（`src/env.ts`）：`COFORGE_EVAL_MANIFEST`（必填）、
`COFORGE_EVAL_ARMS`（默认 warm,cold）、`COFORGE_EVAL_FAMILIES`（逗号分隔过滤）、
`COFORGE_EVAL_EPISODE_TIMEOUT_MS` / `COFORGE_EVAL_SETTLE_MS`（缺省走基准注册表默认）、
`COFORGE_EVAL_EPISODE_CLOSURE=0` 关闭 episode 间 reset-session、`COFORGE_EVAL_SEED`。

输出：`result/<evaluationId>-attempts.jsonl`（每 episode 追加落盘，崩溃安全）+
`<evaluationId>-summary.txt`。attempts 行含 `final_output / recall_state / recall_citations /
mechanism / task_message_count / memory_leak_count`，python grader 只读它们认识的列。

## 后接入的两个基准（已接入、未开跑）

### LifelongAgentBench（lifelongagentbench）

官方协议 = 每任务型一条固定顺序流（db_bench 500 / os_interaction 500 / knowledge_graph 396），
跨任务经验经 Previous-Samples callback 注入。群聊映射：流的顺序保留，PS callback 换成
Memory Agent——warm 臂每集 drain 进 OV、下集 @memory 召回；cold 臂零状态。判分走官方 python
（db: SELECT 逐元组比对 / 变更类 md5；os: 容器内评测命令 exit code；kg: s-表达式终答集合精确匹配）。

```bash
# 数据：HF csyq/LifelongAgentBench 导出行（或仓库本地 entry_dict.json）
bun adapters/emit.ts lifelongagentbench --entries <hf-export.jsonl> \
    --task-type db_bench --output data/llmab-db.jsonl [--limit 50]

COFORGE_EVOLBENCH_COLLAB_EVAL=1 COFORGE_EVAL_MANIFEST=$PWD/data/llmab-db.jsonl \
COFORGE_EVALUATION_ID=llmab-db-smoke bun src/run.ts
```

**环境前置（开跑前必须）**：db_bench 需要 MySQL sidecar、os_interaction 需要逐样本 OS 容器、
knowledge_graph 需要 Freebase SPARQL 端点 + ontology 文件（`/tmp/lifelongagentbench-clone` 已
克隆，判分与容器编排复用其 python）。prompt 中的环境提示词由 adapter 附带（占位说明），sidecar
的具体接线沿用 SkillLearnBench 的 env server 模式。答案引用（md5/答案集）只进 manifest 的
grader 块，永不进频道。

### SkillFlow（skillflow）

官方协议 = 20 个工作流族 × 8-9 个 Harbor 容器任务，族内难度递增、技能库**族内累积族间重置**，
verifier（rubric）判分。这与本 runner 的 warm/cold 完全同构：每族一个 workspace（频道+双 agent
跨任务存续），技能只活在 OV（逐集 drain），Memory Agent 的 offer 即"技能复用"动作（官方 %use
指标 ↔ recall_offered/citations），cold 臂 = 空技能库基线（对应官方 baseline setting）。

```bash
# 数据：hf download zhang-ziao/SkillFlow-Task --repo-type dataset --local-dir <tasks-root>
bun adapters/emit.ts skillflow --tasks-root <tasks-root> --output data/skillflow.jsonl \
    [--families Compensation-Scenario-Modeling]

COFORGE_EVOLBENCH_COLLAB_EVAL=1 COFORGE_EVAL_MANIFEST=$PWD/data/skillflow.jsonl \
COFORGE_EVALUATION_ID=sf-<family>-smoke bun src/run.ts
```

**环境前置（开跑前必须）**：Harbor 容器执行（`/tmp/skillflow-clone` 已克隆：harbor CLI、
docker/harbor-cli-base、`iterative_shared_skills_runner.py` 官方终身协议参照）。任务指令里的
`/root/` 路径映射到任务容器的 /root；判分复用官方 verifier（rubric 输出缺失描述）。
任务 toml 给的 agent 超时 1800s，profile 默认 20 分钟。

两个 adapter 均有单测（`test/adapters.test.ts`，含从 HF 真实下载数据的格式验证：db_bench 行、
Compensation-Scenario-Modeling 家族的 instruction/ranking）。
