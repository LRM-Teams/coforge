# PublicChannel Memory Eval

CoForge 群聊记忆评测：LoCoMo 会话写成 **PublicChannel** Message，经 quiet-window **Admitted Segment** 进入 OpenViking / Causal Memory，再由 Memory Agent 回答 `@memory`。

这不是 OpenViking `vikingbot --group-chat`，也不是 `evol_bench/LoCoMo`。F6 合成烟测仍独立存在。

默认 CI 不跑。需要显式 opt-in，并假定栈已在运行：web + Postgres + Redis + daemon + Memory Agent + 占位 Agent + OpenViking；`causal_openviking` 臂还要 Causal Memory。

## 第一刀

- 数据：`evol_bench/LoCoMo/data/locomo/locomo10.json`（sha256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`）
- sample：`conv-26`
- 题目：类别 1–4 前 6 题，跳过类别 5
- 两臂顺序：`openviking`，然后 `causal_openviking`
- 每臂独立 Workspace + OV account + 一条 PublicChannel
- 灌库时 Memory Agent 必须离线；QA 前脚本会清掉 session 关联
- Headline 正确 = 有频道回复 + 有带 citation 的 Memory Offer + 用过记忆工具（或 citation 可证明）+ LoCoMo 宽松 judge = CORRECT
- 只靠 `message_read` / 频道正文 → `leak`，不进 headline

## 命令

评测包是 bun workspace `@coforge/public-channel-memory-eval`（根 `package.json` 的 `benchmark/*`）。不要给它加 `test` script，避免 `bun run --filter '*' test` 把真 OV / 真 LLM 拉进默认 CI。

在 `cursor-ov-cm-impl` 工作树根目录：

```bash
# 不碰 OV / Agent 的装载与判分自测
bun test benchmark/public-channel-memory/test

COFORGE_PUBLIC_CHANNEL_MEMORY_EVAL=1 \
OPENVIKING_PROTOTYPE_ENABLED=1 \
DATABASE_URL=... \
REDIS_URL=... \
COFORGE_OPENVIKING_URL=http://127.0.0.1:1933 \
OPENVIKING_PROTOTYPE_CONF=infra/secrets/openviking_prototype_ov_conf \
COFORGE_EVAL_JUDGE_BASE_URL=... \
COFORGE_EVAL_JUDGE_API_KEY=... \
COFORGE_EVAL_JUDGE_MODEL=... \
COFORGE_EVAL_MEMORY_AGENT_MODEL=... \
bun benchmark/public-channel-memory/src/run.ts
```

Judge 模型和 Memory Agent 模型必须不同。密钥不要放进 argv 或日志。

可选：

| 变量 | 默认 |
|---|---|
| `LOCOMO_DATA` | `/home/zhoujie22/river2_0/evol_bench/LoCoMo/data/locomo/locomo10.json` |
| `COFORGE_EVAL_SAMPLE_ID` | `conv-26` |
| `COFORGE_EVAL_QA_LIMIT` | `6` |
| `COFORGE_EVAL_ARMS` | `openviking,causal_openviking` |
| `COFORGE_EVAL_RESULT_DIR` | `benchmark/public-channel-memory/result` |
| `COFORGE_CAUSAL_MEMORY_URL` | Causal Memory runtime |
| `COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE` | token → tenantId（因果臂入库需要） |

脚本会建 disposable Workspace 和名为 `memory` / `task` 的 Agent 行。**已在跑的 daemon 必须能连上这个 Workspace 并拉起 Memory Agent**；灌库阶段 Memory Agent 保持离线，QA 前脚本会清 session。`@memory` 会 @mention 名为 `memory` 的 Agent。

产物在 `result/`：`attempts-*.jsonl` 与 `summary-*.txt`。`finally` 会删 disposable Workspace 和 OV account。
