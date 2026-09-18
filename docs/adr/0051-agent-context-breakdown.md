# ADR 0051: Show what an Agent's context window is made of (Claude Code only)

Status: accepted
Date: 2026-09-18

## Context

ADR 0050 gave the profile panel a live `Context NN%` badge — a total. Frank then asked (2026-09-18)
to see the composition behind that number when it matters: hovering the badge should show what the
window is actually made of (system prompt, tools, memory files, skills, messages, free space), with
per-item lists for memory files and skills, so a human deciding "hand this Agent a fresh session?"
can also see *why* the window is as full as it is — e.g. a runaway skills footprint versus a long
conversation. The badge stays display-only; nothing in this design computes or suggests a handoff.

Claude Code has a `/context` command that prints exactly this report. It also works headless
(verified empirically twice on Claude Code 2.1.276, 2026-09-18):

```sh
claude -p "/context" --output-format json --resume <sessionId>
```

It reads the session transcript on disk, makes no model call (`total_cost_usd: 0`), and returns in
roughly six seconds with `local_command: true`, `subtype: "success"`, and the report as a Markdown
`result`. **This is undocumented headless behaviour**: Claude Code's headless docs list only
`/model`, `/effort`, `/fast`, `/color`, `/rename`, `/mcp`, `/config`, and `/output-style` as
`-p`-capable. A future release can change or remove the report format at any time, so the design
must treat that as an expected, visible outcome — never a crash.

No other provider (Pi, Codex, Kiro, Cursor) offers an equivalent signal, and Raft 1.0.32 has no
equivalent feature (checked 2026-09-18). This is CoForge's own design; code, tests, and strings are
written in CoForge's own words.

## Decision

**A. A dedicated request/response pair mirroring the runtime usage scan, but per-Agent.**
`AgentContextScanRequest` (server → daemon, published on the daemon control channel like
`DaemonRuntimeUsageScanRequest`) carries `protocol_major, request_id, workspace_id, computer_id,
agent_id, provider, launch_id, session_id, message_type`, numbered contiguously 1–9.
`AgentContextScanResponse` (daemon → server RPC, method `agent:context_scan_result`) adds
`accepted, status, message, report_json` at 9–13. Statuses are `available | unsupported |
no_session | unparsed | timeout | error`. The server fills `launchId`/`sessionId` from its own
record of the Agent's current control state, but only for correlation and staleness detection —
see B. A format drift in Claude Code surfaces as `unparsed`, a distinct and visible state, never a
crash or a silent empty popover.

**B. The daemon resolves the launch and session from its own tracked state; it never runs the CLI
because the request said so.** `DaemonRuntime.scanAgentContext` reads the Agent's current launch
from `#currentActivityLaunches` and the native session id from `#sessionReferences` (the same
references `#sendContextUsage` reads, ADR 0050). A request naming a launch this runtime has already
superseded is answered `error` without running the CLI. Check order: not running → `no_session`;
stale launch → `error`; provider without `readContextReport` → `unsupported`; no native session id
yet → `no_session`; otherwise `claude -p "/context" --output-format json --resume <sessionId>` runs
in the Agent's own workspace directory with a 20 s timeout. The reply confirms `local_command === true`
and `subtype === "success"` before trusting `result` — otherwise the CLI "answered" a misspelled or
future-removed slash command as a chat message, and that is `unparsed`, not a report.

**C. Only the parsed structure crosses the wire; the raw Markdown never leaves the Computer.**
`report_json` decodes to the SDK's `AgentContextReport`: `provider, model?, usedTokens,
windowTokens, observedAt, categories[{name, tokens, approximate?}], memoryFiles?[{kind, path,
tokens, approximate?}], skills?[{name, source, tokens, approximate?}]`. The daemon's parser is a
pure function with its own unit tests (synthetic fixture carrying the `~220`, `< 20`, and `24.9k`
token forms, an unknown extra section, and garbage input). It recognizes only the header line
(`**Tokens:** used / window`), the first table (the category breakdown — extra columns tolerated),
and optional `### Memory Files` / `### Skills` tables; everything else is ignored. `< N` marks the
value `approximate`; `~N` does not (it is the CLI's normal rounded form). Category names are free
text kept exactly as the CLI printed them (they are Claude Code's own English labels; they are
never translated). `"Free space"` is recognized by name to draw the remainder. Memory-file paths
stay on the wire: they are the Agent's own workspace paths, already shown elsewhere (Workspace
tab).

**D. The server validates the report before storing anything, and the popover re-derives
percentages.** `createAgentContextScanResultMethod` authorizes the daemon principal exactly like
the usage-scan result method (and refuses an Agent-scoped transport principal), validates
`report_json` at the boundary (provider-tagged, bounded strings, finite non-negative counts, a
non-empty category table), and stores the result in a per-Agent Redis cache with the same
24-hour-result / 60-second-pending / 30-minute-staleness rules the runtime usage cache uses.
Non-available statuses are stored verbatim with the daemon's message, because that message *is*
what the popover shows. The Web feature (`useAgentContextReport` +
`AgentContextPopoverContent`) copies the Runtime usage popover's interaction exactly: read on
mount, at most one automatic refresh when the read is stale or missing, a manual Refresh button,
stale/reading/failed states inline — no toast. For a Claude Code Agent the `Context NN%` badge
becomes the popover trigger; other runtimes keep the plain badge + tooltip. Percentages shown per
category are recomputed from `tokens / windowTokens`, never taken from the CLI's own printout. The
stacked bar uses the existing categorical `bg-avatar-1..6` tokens (`lib/avatar-tone.ts`'s palette)
with a neutral for Free space — no red/amber thresholds, consistent with ADR 0050's display-only
rule.

**E. Authorization is the Agent owner, plus Computer online.** The Agent-scoped server functions
(`getAgentContextReport` / `scanAgentContext`) resolve the Agent through the same ownership rule
the Skills and Workspace Files queries use (live Agent in the viewer's Workspace, owned by the
viewer, on a Computer that Workspace is connected to), refuse a non-Claude-Code Agent with a
stable `AGENT_CONTEXT_UNAVAILABLE` code, and gate the scan on the Computer being online. A member
who can see the Agent but not own it sees the badge, not the popover — consistent with the Skills
and Workspace Files panels, which are also owner-only.

## Rejected alternatives

- **Piggy-backing the request or report on an existing message.** Ruled out for the same reason
  ADR 0050 rejected piggy-backing the usage reading: a real wire fact gets its own message. The
  usage scan's request/response shapes differ (per-provider, snapshot-based), and overloading
  `AgentActivity` with token tables would make every Activity consumer parse a report it cannot
  render.
- **Trusting the request's `launchId`/`sessionId` on the daemon.** Rejected: the server's view can
  lag a rebind or a driver-side session replacement. The daemon owns launch truth, so it answers
  from its own state and treats a mismatched launch as `error` without running the CLI.
- **Sending the raw Markdown to the Web client and parsing it in the browser.** Rejected: the
  report is unbounded provider output; parsing at the daemon boundary (one pure, unit-tested
  function) keeps format drift contained and keeps arbitrary Markdown out of every browser.
- **Surfacing parse drift as an empty popover or a toast.** Rejected: Frank asked that a format
  change be visible. `unparsed` is a stored, inspectable state with its own copy; the previous
  report stays readable until the next scan overwrites it.
- **Colouring categories by fullness or adding thresholds.** Rejected as contrary to ADR 0050's
  display-only rule; categorical swatches only.

## Consequences

- **Format drift in Claude Code shows as "cannot read composition"** (`unparsed`), with the stale
  previous report still visible until a later scan replaces it. No crash, no silent emptiness.
- **The server must deploy before the Computer release that ships the daemon half.** An old server
  rejects `agent:context_scan_result` with an unrecognized-method 404; `sendAgentContextScanResult`
  catches it and logs `agent_context_scan_result:rejected` once per connection lifetime (the same
  suppression convention as `agent_session:invalidate_rejected`), and no turn is blocked — the
  scan itself already completed on the Computer; only its delivery never lands, and the popover
  keeps showing its previous state.
- **Server-computed `collectedAt` falls back to receive time** when a report carries no usable
  `observedAt`, so staleness never reads as fresher than it is.
- **Kiro/Pi/Codex/Cursor stay plain badges.** The wire and daemon-core surfaces are provider-
  neutral; a future provider implements `readContextReport` and nothing else changes.
- **`/context` runs one extra CLI process per explicit scan or auto-refresh**, taking ~6 s and no
  model call. It runs only when the popover needs data or the user asks, never on a schedule.

## Validation and rollback

Covered by: `packages/coforge-sdk/src/internal/agent-context-scan.test.ts` (codec round-trips,
negative envelope guards, contiguous wire tags); `packages/daemon/test/
claude-code-context-report.test.ts` (the pure parser: full fixture, `~`/`< 20`/`k` forms, unknown
extra section, garbage, header-without-table); `packages/daemon/test/daemon-runtime.test.ts`
(a running Agent resolves its own launch/session and returns `available` with `report_json`; a
stopped Agent answers `no_session`; a superseded launch is refused without running the CLI);
`packages/daemon/test/daemon-connection.test.ts` (the publication routes to the scan slot and the
result goes out over the RPC; a foreign-Workspace publication is dropped); `apps/web/test/
agent-context-scan-result.test.ts` (daemon-principal gating, report validation, observation-time
fallback, non-available statuses stored verbatim); `apps/web/test/agent-context-cache.test.ts`
(fresh/stale/pending rules, per-Agent key scope); `apps/web/test/agent-context-report-query.test.ts`
(owner gating, offline refusal, request scope); `apps/web/test/agent-context-popover.test.tsx`
(bar/table/lists, recomputed percentages, every failed state's inline reason);
`apps/web/test/agent-profile-tab.test.tsx` (the badge stays a tooltip for non-Claude-Code Agents
and becomes the popover trigger for Claude Code). Rollback is by revert: the feature is additive
wire (two new messages, one new RPC method), Redis keys, and UI, with no data migration in either
direction.