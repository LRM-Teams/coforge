# ADR 0046: Cursor CLI provider

Status: accepted
Date: 2026-09-18

## Context

Frank approved adding Cursor CLI (`cursor-agent`) as a new code-agent provider, alongside CoForge,
Pi, Codex, Claude Code, and Kiro. Cursor's headless mode is fundamentally different from every
provider CoForge already has: every other provider keeps one long-lived process (or RPC
connection) for the life of an Agent session and streams input to it. `cursor-agent --print
--output-format stream-json --force [...] <prompt>` instead spawns, runs exactly one turn to
completion, and exits; there is no stdin channel and no way to send a second message into an
already-running process. A CoForge session therefore has to be a sequence of independent child
processes, one per turn, with the session object itself outliving every individual process.

The team measured real `cursor-agent` output (version `2026.08.11-e8db854`, 2026-09-18) across a
fresh turn using shell/read tools, a resumed turn that reconnected mid-turn, a resume of an unknown
session id, a free-plan/named-model failure, and `cursor-agent models`. The real stream-json output
carries more than CoForge's `AgentSession` contract can express from a single-process model:
top-level `thinking` frames (separate from any assistant message), `tool_call` frames with a
`started`/`completed` lifecycle and provider-specific `<kind>ToolCall` payloads, `connection`
reconnect frames, `retry` frames, and a `user` echo of the prompt. Frank subsequently reviewed the
first implementation of this provider — which mapped that fuller measured shape — and directed a
narrower design: match only the frame set CoForge's own reasoning about the reference behavior
predicted (`system/init`, compaction status, `assistant` message content blocks, `result`), and
leave every other observed frame type unmapped, so CoForge's Cursor coverage is deliberately no
richer than that. This ADR records that decision and its known gap plainly, rather than silently
matching what was actually measured.

## Decision

**Per-turn process model.** `CursorProvider.createAgentSession` (`packages/daemon/src/code-agent/
cursor/provider.ts`) returns one long-lived `CursorAgentSession` object; each turn spawns one
`CursorTurnProcess` (`cursor/turn-process.ts`), a minimal process-tree-owning wrapper — not
`JsonlProcess`, whose persistent-process contract treats every exit (even a clean one) as an
unexpected failure and never exposes the real exit code, both wrong for a provider whose normal
unit of work is "one process, one exit." `CursorTurnProcess` reuses the same `ProcessTreeOwner`
ownership and `AgentProcessCleanupError` cleanup ladder (`terminate(false)` → wait → `terminate(true)`
→ wait → throw) every other provider's process wrapper uses, and reports the turn's real exit code
and a bounded stderr tail once the process exits on its own.

- A **fresh session** (no `sessionId`) has no other way to receive a system prompt — Cursor has no
  native system-prompt flag — so `createAgentSession` spawns the first turn immediately, with the
  whole prompt being the standing instructions alone, and waits only for that turn's `system/init`
  frame (session identity) before returning; the turn itself keeps running.
- A **resumed session** (`sessionId` given) spawns nothing until real input arrives.
- Argv is exactly `--print --output-format stream-json --force [--model <id>] [--resume
  <sessionId>] <prompt>`, prompt always last. `default`/empty `model` is never passed as `--model`.
  Env is `agentEnvironment(...)` plus `NO_COLOR=1`.
- Input (`sendMessage`/`notify`) while idle spawns the next turn immediately; input while a turn is
  running (including the fresh session's own bootstrap turn) queues and is delivered, joined with
  `"\n\n"`, as the single next turn once the current process exits — resolved once that next turn's
  process has actually been spawned, not once it finishes.
- `interrupt()` sends `SIGINT` to the running turn's process and resolves once it exits, reporting
  `completed: "interrupted"`. `dispose()` kills any running turn, rejects queued input, and is the
  only source of `onExit` — a finished turn is not a session exit; the session stays alive (idle)
  between turns exactly as Claude Code's persistent process stays alive between `sendMessage` calls.
- There is no missing-session recovery path: `--resume <unknown-id>` never fails, Cursor silently
  starts a fresh chat under whatever id it reports back, and CoForge just tracks that id for the
  next turn.

**Frame mapping** (`CursorAgentSession#handleRecord`) recognizes exactly:

| Frame | CoForge event |
| --- | --- |
| `system` `subtype:init`, `session_id` | records session id, reports it via `onSessionId`, emits `session` identity (`empty` the first time a fresh session sees one, `unknown` while any later turn is in flight, `resumable` after a turn completes successfully) |
| `system` `subtype:status` `status:compacting` | `compaction-started` |
| `system` `subtype:compact_boundary` | `compaction-finished` |
| `assistant` → each `message.content[]` block | `thinking` (non-empty `.thinking`) → `thinking-delta`; `text` (non-empty `.text`) → `text-delta`; `tool_use` → `tool-start` (`name` from `block.name` or `"unknown_tool"`, `id` from `block.id` or a generated id, `input` passed through raw) |
| `result` | `subtype` (default `"success"`) `!== "success"` or `is_error` → an `error` event whose message joins trimmed `errors[]` strings and a trimmed `result` string with `" | "` (or `"Execution failed"` if both are empty); otherwise records success. Either way this frame does not by itself end the turn. |
| every other frame type | nothing |

Turn end is the **process exit**, not the `result` frame — the `result` frame only records whether
the turn reported an error. A clean exit completes the turn, with or without a `result` frame. A
non-zero or signal exit fails the turn and emits an `error` event carrying the exit summary and the
recent stderr lines as raw facts (`exit code 1 | stderr: <line> | <line>`); the daemon core redacts
and caps that text like every other runtime failure. The observed free-plan/named-model failure is
exactly this shape: only `system/init` and `user` frames, then exit 1 with stderr
`ActionRequiredError: Named models unavailable Free plans can only use Auto. …`, no `result` frame.

**Deliberately unmapped, even though measured:** the real `thinking` frame type (Cursor's actual
thinking delivery is `{"type":"thinking","subtype":"delta"|"completed","text":…}` at the top level,
never inside an `assistant` content block), `tool_call` frames (`started`/`completed`, with
`shellToolCall`/`readToolCall`/other `<kind>ToolCall` payloads — Cursor's tool activity never
arrives as an `assistant` `tool_use` block either), `connection` (`reconnecting`/`reconnected`),
`retry` (`starting`/`resuming`), and the `user` echo of the prompt. None of these produce any
CoForge event today. This means, concretely, that a real Cursor turn using shell or file tools
currently shows CoForge no tool activity, and a reconnect currently shows no `reconnecting`
Activity — both real, observed gaps, not omissions this ADR is unaware of.

**Model catalog** (`cursor/catalog.ts`): `cursor-agent models`, 5 s timeout, `NO_COLOR=1`/
`FORCE_COLOR=0`. Each model line is an id optionally followed by ` - <label>` (the label falls back to the id);
ANSI escapes are stripped; a trailing parenthesised marker list is removed only when every marker is
`current` or `default`, and `default` sets `recommended`; the `Available models` header, blank
lines, `Tip:` lines, `No models available…`, and `Failed to load models:…` are skipped
(case-insensitive), as are flag-like ids starting with `-`. A non-zero exit or a timeout returns no catalog rather than throwing. There is no
reasoning control (Cursor bakes effort into the model id) and no `readUsage` — the Runtime usage
popover shows the CLI's own model/version, empty request. Skills roots follow
[Cursor's documented locations](https://cursor.com/docs/skills): project `.cursor/skills`, personal
`~/.cursor/skills`; no other root is documented.

## Comparison with the reference behavior

CoForge's own prior understanding of the reference product's parser (`docs/agents/
reference-cli-research.md` process; not independently re-verified against the 1.0.32 binary for
this ADR) is that it reads `system/init`, compaction status frames, `assistant` message content
blocks, and `result` — the same five-row table above. The frames this build measured beyond that
set (`thinking`, `tool_call`, `connection`, `retry`, `user`) either did not exist when that
understanding was formed, or were never part of it. Frank's explicit direction for this
implementation was to match that narrower understanding exactly, including its blind spots,
rather than have CoForge's Cursor provider observe more than that. The measured captures that
exercise those unmapped frame types are kept as test fixtures specifically to prove they produce
no event, not to justify mapping them.

## Rejected alternative

The first implementation of this provider mapped the fuller measured shape directly: real
`thinking` frames to `thinking-delta`, `tool_call` `started`/`completed` frames to
`tool-start`/`tool-output`/`tool-end` (with a kind-to-CoForge-tool-name table mirroring
`tool-activity.ts`'s Claude-style names), and `connection`/`retry` frames to `reconnecting`/
`progress`. Rejected by Frank in favor of the narrower design above: shipping Activity CoForge has
not deliberately decided to support is a bigger cost than a known, documented gap, and the
narrower parser is trivial to re-widen later from the same test fixtures once tool/reconnect
Activity for Cursor is an explicit decision rather than an implementation default.

## Consequences

- Tool use, thinking, and reconnect Activity are not visible for Cursor Agents until a follow-up
  decision widens the frame mapping; that follow-up can reuse the fixtures already committed here
  (`packages/daemon/test/fixtures/cursor-turn-*.jsonl`).
- The synthetic `assistant`-content `thinking`/`tool_use` mapping (rows two and four of the table)
  is exercised only by a synthetic test fixture, not by any real capture, since real Cursor never
  places them there. It stays in the contract because a future Cursor build, or a different
  `--output-format`, could use it, and because it costs nothing to keep parsing.
- `RUNTIME_PROVIDER.CURSOR` is additive to the wire enum (`packages/coforge-sdk/src/internal/
  index.ts`); no database schema change, since `provider` columns are plain `String`, not a DB
  enum.

## Validation and rollback

Validated by `packages/daemon/test/cursor-agent-adapter.test.ts` (frame mapping including the
ignored real frames, argv building, bootstrap/resume lifecycle, queued input coalescing, interrupt,
dispose), `packages/daemon/test/cursor-catalog.test.ts` (model list parsing and process discovery),
`packages/daemon/test/runtime-inventory.test.ts`, `code-agent-registry.test.ts`, and
`agent-skills.test.ts`/`assigned-skills.test.ts` (Cursor added to the existing provider coverage),
plus `bun run check`/`bun run test`/`bun run build`. Rollback is reverting the commit(s); Cursor
selection is additive everywhere (`RUNTIME_PROVIDER`, the registry switch, runtime discovery,
Skills roots, and the web runtime picker), so removing it leaves every other provider unaffected.
