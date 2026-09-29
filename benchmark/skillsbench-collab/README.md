# SkillsBench Group-Chat Collaboration Eval (coforge + openviking)

参照 `OpenViking/benchmark/skillsbench/skill_bench_eval.py`（instruction → agent 用 skill 执行
→ 任务自带 pytest 验证打分）的测试方法，把执行搬进 coforge 群聊产品链路，测**多 Agent 协作
+ 技能通过记忆下发**：技能不预装，只能由 Memory Agent 检索后经 Memory Offer 交给执行者。

> 对应产品设计注释（packages/agent/src/runner.ts）："Team memory and skills come from the
> Memory Agent" —— 本基准把这句话变成可测的行为。

## 拓扑（每任务一个一次性 workspace + 一次性 OV 账号）

| 成员 | 角色 |
| --- | --- |
| `user`（人类） | 发任务指令；技能文档的频道发布者（灌库用） |
| `task`（Task Agent） | 执行者。**无任何本地 skill**（eval 隔离了 host 注入），有 shell，工作区=执行根目录 |
| `memory`（Memory Agent） | 只检索。openviking-memory fence（ov_find / ov_read / memory_offer） |

## 协作链（被测机制）

1. **灌库**：任务 `environment/skills/` 的每个 skill 以回填时间的频道消息发布（每文件一条，
   `[skill: <name> — file: <rel>]` 头 + 原文）→ quiet-window → Admitted PublicChannel Segment
   → OpenViking（每个 skill 一个 segment）。
2. **下发**：人类发 `@memory <instruction>`（`/root/` 前缀按 OV 脚本同样方式重写）→
   Memory Agent 检索 → 发布带引用的 Memory Offer（offer 体携带技能内容）→ 产品把 offer
   路由给频道 peer = Task Agent 并以 `@task` mention 唤醒它。
3. **执行**：Task Agent 读 offer 里的技能，在自身工作区用 shell 执行任务（环境文件已由
   harness 落到工作区根——那些是执行输入，不是知识），完成后在频道汇报。
4. **判分**：harness 把 Task Agent 工作区拷贝到 verify 目录，移植 OV 验证器的路径重写逻辑
   后跑任务自带 pytest。`passed/collected` = test_score；pass_rate = passed 任务数 / 总任务数。

## 机制判据（mechanism）

| 判据 | 含义 |
| --- | --- |
| `ok` | offer 存在、citations ≥ 1、Task Agent 有汇报 |
| `no_offer` | 没有 offer——技能没走记忆通道（Task Agent 无本地技能，属硬失败） |
| `uncited_offer` | offer 无引用 |
| `leak` | Memory Agent 在 offer 之外发频道消息 |
| `no_reply` / `timeout` | 未汇报 / 整链超时（timeout 时 pytest 照跑，产物可能已完整） |

headline = mechanism 合格且 pytest passed。**判分者是 pytest，不是回复文本。**

## 数据准备

```bash
git clone --depth 1 https://github.com/benchflow-ai/skillsbench.git /tmp/skillsbench-clone
mkdir -p bench_data
cp -r /tmp/skillsbench-clone/tasks bench_data/tasks     # 87 tasks → 86 available
```

布局说明：现行上游任务为 `task.md`（YAML frontmatter + 指令正文）+ `verifier/test_outputs.py`
+ `environment/`（含 `skills/`）；OV 脚本针对的旧版是 `instruction.md` + `tests/`。loader
两种布局都支持（`src/tasks.ts`）。技能文件均为文本（最大 240K 的 XSD）。验证需要
`python3 -m pytest`（本机 7.4.4 已可用），pytest 超时对齐任务 schema 的 900s
（`COFORGE_EVAL_PYTEST_TIMEOUT_MS` 可覆盖）。

## 运行

前置与 sibling 评测一致：web(:8788)+redis+centrifugo+Postgres、OpenViking docker（带
`--cpuset-cpus=0-1`）、`apps/web/.env`、`~/.pi/agent/models.json`、OV conf。

```bash
cd benchmark/skillsbench-collab
COFORGE_SKILLSBENCH_COLLAB_EVAL=1 \
DATABASE_URL=... REDIS_URL=... \
COFORGE_EVAL_TASKS=<task-name> \
bun src/run.ts                     # 单任务
```

主要环境变量（`src/env.ts`）：

- `COFORGE_EVAL_TASKS`：逗号分隔任务名；缺省取第一个（`COFORGE_EVAL_TASK_COUNT` 控制）
- `SKILLSBENCH_TASKS_DIR`：任务目录（默认 `<benchmark>/bench_data/tasks`）
- `COFORGE_EVAL_POLL_TIMEOUT_MS`（默认 2700000=45min，对齐 OV 的 2400s 执行窗口 + 两跳）
- `COFORGE_EVAL_SETTLE_MS`（默认 180000，Task Agent 静默窗口——执行期间可能长时间不发消息）
- `COFORGE_EVAL_PYTHON`（默认 python3）
- `COFORGE_EVAL_OV_ACCOUNT`：复用账号（续跑）；复用时**不要删账号**

结果：`result/attempts-*.jsonl`（含 verification 全文）+ `result-*.csv`（对齐 OV 的
result.csv 列）+ `summary-*.txt`（pass_rate / score 汇总）。

已知怪癖沿用 sibling 评测：prisma `$disconnect` 挂起由外层 watchdog 处理（看到
`wrote .../attempts-` 日志后 pkill）；SIGTERM 可能留下 workspace/binding。

## 与 OV 原版的关键差异

| OV skillsbench | 本基准 |
| --- | --- |
| skills 拷进 agent 的 storage workspace，本地可发现 | skills 只进 OpenViking 记忆，经 Memory Offer 下发 |
| vikingbot chat 一步执行 | 群聊两跳：@memory 检索 → offer 唤醒 Task Agent 执行 |
| 判分 pytest（相同重写逻辑移植） | 相同 |
| 无 memory agent 角色 | 检索是成败关键（no_offer 即硬失败） |
