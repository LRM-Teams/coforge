# ADR 0058: OpenCode provider

Status: accepted
Date: 2026-09-21

## Context

Frank approved adding OpenCode (`opencode`, SST) as a code-agent provider, alongside CoForge, Pi,
Codex, Claude Code, Kiro, and Cursor. OpenCode's non-interactive surface has the same shape as
Cursor's: `opencode run --format json [...] <prompt>` spawns one process per turn, prints one JSON
event per line, and exits when the turn is over — there is no way to send a second message into a
running turn. It is the one provider Raft documents as _having_ a thinking selector for a reason
CoForge can reuse directly: when a model exposes `variants`, Raft shows them as the agent thinking
selector, while other runtimes (Cursor, for one — ADR 0046) bake the effort into the model id. In
OpenCode v2 that effort rides the model id too (`--model provider/model#variant`), which is the form
this provider uses.

The v2 contract is published as OpenCode `2.0.x` (the `@opencode/cli` npm package; the retired
`opencode-ai` package stops at `1.18.x`) and was measured against the released CLI (`2.0.12` on
`s144`, 2026-09-22), not just its source: `opencode run` accepts `--format json`, `--model`
(`provider/model#variant`), `--session` and `--auto` and a positional message, while `--dir`,
`--variant` and `--dangerously-skip-permissions` are **gone** (v2 takes the working directory from the
process cwd / `PWD`, folds the effort into the model id, and calls auto-approval `--auto`). `opencode
models` still lists `provider/model` rows, but the `--verbose` metadata form exists only on
OpenCode's `dev` branch today, so on `2.0.12` the catalog degrades to the id list. One v1 install
(`1.18.31`) is still present on `s144` and is intentionally gated out. Raft's Go adapter
(`server/pkg/agent/opencode.go`, `opencode_serve.go`, `opencode_mcp.go`, `models.go`) remains the
reference for the event vocabulary. v1 is intentionally not a supported runtime.

## Decision

**Per-turn process model, the same one Cursor uses.** `OpenCodeProvider.createAgentSession`
(`packages/daemon/src/code-agent/opencode/provider.ts`) returns one long-lived
`OpenCodeAgentSession`; each turn spawns one `OpenCodeTurnProcess`
(`opencode/turn-process.ts`) — process-tree-owning, not `JsonlProcess`, for the same reason Cursor
needed its own wrapper: one process _is_ one turn, so a clean exit completes the turn rather than
faulting the session.

- Argv is `run --format json --auto [--model <provider/model[#variant]>] [--session <sessionId>]
<prompt>`. `default`/empty `model` is never passed, and a variant is only expressed when a model
  is chosen (v2 has no standalone `--variant`). Env is `agentEnvironment(...)` plus `NO_COLOR=1` and
  `PWD=<agentWorkspaceDirectory>`; the turn is also spawned with that directory as its cwd, because
  OpenCode resolves its discovery root (the `AGENTS.md` walk-up and `.opencode/skills/`) from the
  working directory / `PWD` and v2 has no `--dir` to pass it explicitly.
- A **fresh session** sends the standing instructions as its whole first-turn prompt (OpenCode v2
  reads a project's `AGENTS.md` itself and has no system-prompt flag); a **resumed session**
  spawns nothing until real input arrives. Input while a turn is running queues and is delivered,
  joined with `"\n\n"`, as the next turn.
- Session identity comes from OpenCode's own events (`sessionID`, on the event or inside `part`),
  and is reused for resume with `--session`. A clean exit marks the session `resumable`; a non-zero
  exit fails the turn with its exit code and a bounded stderr tail (the daemon core redacts and caps
  the text, as for every provider).
- **Mapped events**: `text` → `text-delta`; `tool_use` → `tool-start` plus `tool-output`/`tool-end`
  when `part.state.status` is `completed`/`error`; `error` → the provider's own message, failing the
  turn; `step_start` → `progress` (liveness). `step_finish` is read but produces no CoForge event —
  see "Known gaps".
- **Model catalog**: `opencode models --verbose` (15 s, Raft's budget), falling back to the plain
  `opencode models` when verbose yields nothing—including when the CLI does not know `--verbose`,
  which is the released `2.0.12` case (the flag is on OpenCode's `dev` branch). Model ids are kept
  **verbatim** (that is what `--model` accepts), `provider/model`'s first segment becomes the model
  provider, and a model's enabled `variants` become its `reasoningEfforts`, ordered by OpenCode's
  own effort order (`none < minimal < low < medium < high < xhigh < max`). A model is only given a
  picker when it declares `capabilities.reasoning` or carries a variant that looks like an effort,
  mirroring Raft's gate. Failure of any kind means "no catalog", never a thrown error. Until a CLI
  ships `--verbose`, the catalog therefore lists ids with **no reasoning pickers** — a silent
  capability loss, recorded under "Known gaps".
- **Version gate**: runtime discovery reports an OpenCode install below **2.0.0** as unavailable
  (`opencode/version.ts`), and an existing Agent's launch is re-checked immediately before spawn.
  This is a correctness gate, not polish: an older build handed a flag it does not know silently
  prints its usage and exits 0 instead of running, so without it a stale install would look like a
  healthy runtime that never produces a turn.
- **Skills**: `.opencode/skills/` in the Agent workspace, which is where OpenCode natively discovers
  project skills (Raft's `execenv/context.go` writes `{agentRoot}/.opencode/skills/{name}/SKILL.md`
  for the same reason). No global skill directory is claimed: the installed CLI documents none.
- **Delivery mode**: `steer`, like every provider whose `notify()` has a safe busy path (a queued
  turn, here).

## Known gaps (deliberate, not silent)

- **No usage reader.** OpenCode reports per-turn token counts on `step_finish`, but CoForge's
  `UsageSnapshot` models plan/rate-limit windows, not per-turn tokens, and the account-level plan
  usage has no equivalent read; the provider implements neither `readUsage` nor `readContextReport`,
  exactly like Cursor and Kiro.
- **No MCP injection.** Raft projects `agent.mcp_config` through `OPENCODE_CONFIG_CONTENT`; CoForge
  has no MCP config concept in its Agent launch contract yet, so nothing is injected and the
  workspace's own `opencode.json` is left untouched (the provider never writes it).
- **No Agent-specific API key.** `RUNTIME_PROVIDER_USES_EXTERNAL_CLI` marks OpenCode as an external
  CLI, so the CoForge-managed model-provider key path does not apply; OpenCode uses its own login.
- **No reasoning picker on the released v2 CLI.** `opencode models` on `2.0.12` accepts no
  `--verbose`, so the per-model `variants` metadata (and therefore the thinking selector) is
  unavailable until a CLI ships the flag; the plain id list still resolves. No error is raised.
- **Model metadata we do not carry.** The catalog's `limit.context`/`maxTokens` are parsed by
  OpenCode but have no field in `CodeAgentModelMetadata`; `recommended` stays false because the CLI
  marks no default model (Cursor's `(default)` marker has no OpenCode equivalent).
- **Non-interactive permissions** rely on `--auto`, which is why the 2.0 baseline matters; the
  provider does not fall back to `OPENCODE_PERMISSION`.
