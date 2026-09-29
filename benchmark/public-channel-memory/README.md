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
DATABASE_URL=... \
REDIS_URL=... \
CURSOR_API_KEY=... \
bun benchmark/public-channel-memory/src/run.ts
```

Judge 走本机 Cursor CLI：`agent -p --mode ask --sandbox enabled`（空临时 workspace）。密钥只走环境变量 `CURSOR_API_KEY`，不进 argv。默认模型 `grok-4.6`。

Memory Agent 默认走 Pi 自定义 provider，与 `~/.pi/agent/models.json` 同一钉：provider `lenovo-deepseek-v4-flash`、model `DeepSeek`。网关用这个 id 提供 `DeepSeek-V4.1-Flash`。脚本写入 Agent `runtimeConfig`（`runtime: "pi"`，`provider: { kind: "default" }`），密钥仍由本机 Pi 配置提供，不写进评测环境变量或 argv。Judge 模型和 Memory Agent 模型必须不同。

评测启动频道里**每一个 Agent**（Memory Agent 和占位 task Agent 都一样）时关掉 Pi 自己的 memory / skill 注入：`COFORGE_EVAL_DISABLE_HOST_PI_INJECTION=1`，不读 `~/.pi/agent/skills`、不灌 `MEMORY.md`、不装 assigned skills。群聊记忆和 skill 只走 Memory Agent 的 fence 工具（OpenViking / Causal Memory + offer）。

可选：

| 变量 | 默认 |
|---|---|
| `LOCOMO_DATA` | `/home/zhoujie22/river2_0/evol_bench/LoCoMo/data/locomo/locomo10.json` |
| `COFORGE_EVAL_SAMPLE_ID` | `conv-26` |
| `COFORGE_EVAL_QA_LIMIT` | `6` |
| `COFORGE_EVAL_ARMS` | `openviking,causal_openviking` |
| `COFORGE_EVAL_RESULT_DIR` | `benchmark/public-channel-memory/result` |
| `CURSOR_CLI` | `agent` |
| `COFORGE_EVAL_JUDGE_MODEL` | `grok-4.6` |
| `COFORGE_EVAL_MEMORY_AGENT_PROVIDER` | `lenovo-deepseek-v4-flash` |
| `COFORGE_EVAL_MEMORY_AGENT_MODEL` | `DeepSeek` |
| `COFORGE_EVAL_JUDGE_MODEL` | `composer-2.5`（Cursor judge） |
| `COFORGE_CAUSAL_MEMORY_URL` | Causal Memory runtime |
| `COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE` | token → tenantId（因果臂入库需要） |

脚本会建 disposable Workspace 和名为 `memory` / `task` 的 Agent 行。灌库阶段不挂 daemon。QA 前脚本会：

1. **因果臂**：若 `:9938` 不通，用本机 `causal-memory http` 拉起 host-run runtime，并写一份一次性 `token → workspaceId` 映射（不复用 docker secret 里那份非 JSON 文件）。
2. **两臂**：为这个 disposable Workspace **注册 Computer 并启动评测专用 DaemonRuntime**。不要指望 `/home/zhoujie22/river2_0/coforge` 里已在跑的 `dev-memory-daemon`（它绑的是另一个 Workspace）。

`@memory` 经 Centrifugo 推到这台 daemon。因此还要有：

- **本工作树的 Web**（不是 `coforge` 树上 8788 那个）。8788 已被占用时用 `PORT=8789`，并设 `COFORGE_WEB_URL=http://127.0.0.1:8789`
- 从现有 `apps/web/.env` 带出 `COFORGE_CENTRIFUGO_API_URL`、`COFORGE_CENTRIFUGO_API_KEY`、`COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY`（不要 echo）

灌库后脚本会清 Memory Agent session，再走产品 `AgentControl.start` 把 Memory Agent 拉起来（频道消息只投递、不 Start；没 Start 过的 Agent 收消息会 `Agent is inactive`）。`@memory` 会 @mention 名为 `memory` 的 Agent。

产物在 `result/`：`attempts-*.jsonl` 与 `summary-*.txt`。`finally` 会删 disposable Workspace 和 OV account。
