# ADR 0055: Classify runtime failures, back off deliveries, and fence a repeating one

Status: accepted
Date: 2026-09-20

## Context

Step C of an agreed plan (A = ADR 0047 Kiro turn errors carry their reason; B = ADR 0048 the
daemon-owned delivery queue). D (terminal auth handling), E (stall watchdog), and F (crash
restart) are later CRs and out of scope here.

Before this change:

- `packages/daemon/src/agent-runtime/runtime-error-activity.ts` already scrubbed failure text,
  fingerprinted it (FNV-1a, `fingerprintRuntimeError`), and emitted `runtimeError { errorClass,
  errorReason, fingerprint }` on the wire (`AgentActivity.runtimeError`,
  `packages/coforge-sdk/src/internal/index.ts`). `errorClass`/`errorReason` were only ever a
  provider's own hint (`event.providerErrorClass ?? event.providerErrorCode ?? "AgentRuntimeError"`
  / `event.providerErrorReason ?? "runtime_failure"`) — the daemon never classified a failure
  itself, so a rate limit, an expired login, a dead network, and a bad model all arrived as the
  same undifferentiated `AgentRuntimeError`/`runtime_failure`.
- Nothing consumed the fingerprint. It was emitted and forgotten.
- `packages/daemon/src/daemon-runtime/agent-delivery-queue.ts` (ADR 0048) already owned queued
  deliveries and exposed a deliberate `hold`/`release` seam, built specifically for "error backoff"
  and "the 3-strike fence" to attach to later. This CR is that caller.
- There was no cooldown anywhere on the spawn path: every wake re-attempted a spawn, so an Agent
  whose runtime could not start burned one full spawn attempt per delivered message, forever. This
  was independently fixed by PR #470 (`fix(daemon): retry a failed Agent launch with capped
  exponential backoff`, merged onto `main` immediately before this branch's base commit) — see
  "Spawn-failure cooldown" below for how it maps onto this brief's requirements.

Reference product: Raft Computer 1.0.32, daemon bundle
`packages/daemon/dist/chunk-TEGPBMW7.js` (this checkout: 41,996 lines). Match Raft's behaviour
(thresholds, which errors, what the user sees), never its identifiers, comments, or prose — see
"Divergences" for every place this PR reads differently or could not confirm.

## Decision

### 1. Classification: `agent-runtime/runtime-error-classification.ts`

A table-driven, ordered classifier (`classifyRuntimeErrorText(message)`) turns a failure's own
text into a CoForge `errorClass`, `errorReason`, and an explicit `retryDecision` of `"retry"` or
`"terminal"`. It never looks at a provider's own hint — `providerErrorClass`/`providerErrorCode`/
`providerErrorReason` are still kept as-is wherever a provider supplies one (unchanged); the
classifier only fills the previous generic default (`"AgentRuntimeError"`/`"runtime_failure"`) for
text no provider has already explained.

| CoForge class | errorReason | Retry decision |
|---|---|---|
| `LauncherError` | `launcher_error` | terminal |
| `InputTooLargeError` | `input_too_large` | terminal |
| `AuthError` | `auth_required` | terminal |
| `ModelConfigError` | `model_not_supported` | terminal |
| `TimeoutError` | `provider_timeout` | terminal |
| `ProviderConnectionError` | `provider_connection_error` | retry |
| `ProviderStreamError` | `provider_stream_error` | retry |
| `RateLimitError` | `rate_limited` | retry |
| `ProviderServerError` | `provider_server_error` | retry |
| `NotFoundError` | `not_found` | retry |
| `AgentRuntimeError` (fallback: nothing else matched) | `runtime_failure` | retry |

Raft's own table (`classifyRuntimeError`, chunk line 9358) matches the same shape: a launcher
pattern list, an explicit `*Error`/`*Exception` name, input-too-large text, HTTP-status branches
(429/401/403/404/≥500 — CoForge has no HTTP status to classify on; see Divergences), then text
patterns for auth, unsupported model, timeout, connection errors
(`ECONNRESET`/`EPIPE`/`ECONNREFUSED`/`ENOTFOUND`/`EAI_AGAIN`), stream errors, capacity/rate-limit
wording, falling back to a generic class. CoForge's retry/terminal split for the four always-retry
classes (rate limit, provider server error, provider connection error, provider stream error) and
the never-retry timeout class matches Raft's `recoverableRuntimeDeliveryBackoffReason`
(chunk line 12272) exactly. Everything else is a deliberate simplification — see Divergences.

`runtime-error-activity.ts`'s `buildRuntimeErrorActivity`/`buildRuntimeCrashedActivity` use this
classifier only for the *displayed* `errorClass`/`errorReason` fallback. `daemon-runtime/
runtime.ts` uses it unconditionally (ignoring any provider hint) to decide the retry action,
because an arbitrary provider-native hint string (`"CodexTurnError"`, `"-32600"`, …) is not
something a fixed retry table can look up.

No new wire field: everything above rides the existing `runtimeError.errorClass`/`errorReason`
strings.

#### `TimeoutError`'s scope, decided explicitly

`TimeoutError` is classified `terminal`, matching Raft's own `recoverableRuntimeDeliveryBackoffReason`
returning `null` for it (chunk line 12272) — a timeout gets no delivery backoff there either. But in
Raft that `null` means only "no delivery backoff"; a hung provider is instead handled by a *separate*
stall watchdog (this plan's E, out of scope here), not folded into Raft's sticky-terminal/
action-required class. CoForge's two-tier model has no third bucket, so `terminal` here is being
asked to carry a meaning narrower than its name suggests: **today it means only "do not hold a
delivery behind a backoff for this occurrence" — it is not itself evidence the Agent needs to stop
or that a user must act.** I chose to keep `TimeoutError` terminal rather than move it to `retry`,
because retrying (holding and redelivering the same message) into a session that may be genuinely
hung does not help either — a stuck provider needs a kill/restart, which this CR does not build.
Moving it to `retry` would also contradict the verified reference behaviour above. The cost is a
naming trap: **when D gives `terminal` real teeth (stopping the Agent, prompting a user re-auth),
it must re-examine `TimeoutError` specifically before attaching that behaviour to it** — a transient
provider timeout is not the same fact as an expired credential, even though both currently classify
as `terminal` in this PR's simplified table. `RUNTIME_ERROR_RETRY_DECISION.TERMINAL`'s own doc
comment and the `TimeoutError` rule's inline comment both carry this note so it is not lost to
anyone reading only the code.

### 2. Delivery backoff: `agent-runtime/runtime-error-recovery.ts` + `daemon-runtime/runtime.ts`

On a retryable `error` event, `daemon-runtime/runtime.ts` calls the existing
`AgentDeliveryQueue.hold(agentId, untilMs)` (ADR 0048) and schedules a plain `setTimeout` (matching
the rest of `runtime.ts`'s existing timer style, e.g. `#activityHeartbeatTimers`; see
Divergences for why this PR does not add an injectable clock) to `release(agentId)` once the
backoff elapses, flushing anything released through the same coalesced-notice path turn-end
draining already uses. A non-retryable error does none of this — no hold is created, so nothing
new is left waiting behind a backoff that could never usefully resolve (D owns the user-facing
side, e.g. actually surfacing an auth prompt).

Constants (`RuntimeErrorDeliveryBackoff`, `runtimeErrorDeliveryBackoffDelayMs`):

- Base: 10,000 ms. Cap: 300,000 ms (5 min). `delay(attempts) = min(cap, base * 2^(attempts-1))`.
- Jitter: up to 10% of the capped delay, drawn from an injectable `jitterRandom(): number` source
  (production uses `Math.random`; unit tests inject a fixed source), added on top and re-capped.

This matches Raft's `RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS`/`_MAX_MS` (chunk line 30770-30771: `1e4`
/ `5 * 6e4`) and `computeRuntimeErrorDeliveryBackoffDelayMs` (chunk line 30884-30897/31441-31447:
the same `base * 2^(attempts-1)`, capped, plus `floor(cappedDelay * jitterRatio * randomUnit)`,
`jitterRatio` defaulting to `0.1`, `jitterRandom` injectable) exactly.

A successful turn (`event.type === "completed"` with `status === "completed"`, never `"failed"` or
`"interrupted"`) resets the streak (`RuntimeErrorDeliveryBackoff.reset`), cancels any pending
release timer, and releases/flushes anything still held — before the pre-existing ADR 0048
`idle(agentId)` turn-end drain runs, so nothing double-drains. An explicit Stop
(`#releaseAgentRuntime`) also cancels the timer and resets the streak, alongside `AgentDeliveryQueue
.clearAgent`'s existing discard of anything held — a fresh launch never inherits a stale backoff.

### 3. Repeat fence: same module, `RuntimeErrorFingerprintFence`

Consecutive retryable failures carrying the *same* `fingerprintRuntimeError` value are counted
separately from the plain attempt streak above. On the third in a row
(`RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD = 3`), the daemon stops retrying that fingerprint:
**no new hold/backoff cycle is scheduled, and — critically — nothing currently held is released or
flushed.** `#applyRuntimeErrorFingerprintFence` cancels any pending release timer and keeps (or
freshly starts) `AgentDeliveryQueue`'s explicit hold with no expiry, so a fenced Agent stops
receiving deliveries entirely instead of the backoff loop continuing to feed the same broken
runtime. (An earlier revision of this PR got this backwards — it released and flushed on trip,
which delivered straight into the failing runtime and left the Agent with *no* protection at all
past the third failure; see "Held deliveries while fenced" below for why the fix is safe, and the
regression test `"a fenced Agent stops delivering entirely…"` that covers it.) The `runtime_error`
Activity's `errorReason` becomes `"runtime_error_fenced"` with a `detail` that names the streak
length, repeats the last error, and tells the operator to restart the Agent — CoForge's own words,
not a copy of Raft's fence-detail sentence. The fence's own streak is untouched by a merely
non-retryable failure (a different, unrelated problem should not extend or break a same-fingerprint
streak it is not part of) and — like the backoff streak — only resets on a genuinely successful
turn or an explicit Stop (never on a mere relaunch — see "State persistence" below).

#### Held deliveries while fenced

Only an explicit Stop clears a tripped fence's hold (`#releaseAgentRuntime` →
`AgentDeliveryQueue.clearAgent`); an unexpected exit and any relaunch that follows inherit it
unchanged, so a fenced Agent stays fenced across a mere process restart — the underlying problem
that tripped the fence (a broken credential, an unreachable host, a bad model config) almost always
outlives a bare process restart, and the daemon has no way to tell otherwise without a human
deciding to Stop first. Traced through every path a held delivery can take from here, so none of
them silently loses a message the cloud's canonical Message/read state could not otherwise recover:

- **Explicit Stop.** `AgentDeliveryQueue.clearAgent` discards `#held` without sending any ACK. This
  is safe by the architecture's existing rule (`handleAgentMessage`'s own runner-hold comment): an
  unacked delivery leaves the server's `receivedAt` null, so the message is re-fetched after the
  next Start — never lost, never assumed read.
  Nothing new here; this is ADR 0048's existing Stop behaviour, unaffected by this PR.
- **Unexpected exit (crash) while fenced.** `AgentDeliveryQueue.onProcessExit` only clears `#busy`;
  it never touches `#explicitHolds` or `#held`. The fenced hold and everything queued behind it
  survive the crash byte-for-byte, in memory, until the next launch's own reconciliation runs.
- **Relaunch (`#recoverAttention`, ADR 0048), whether after a crash or an explicit server Start.**
  Every launch enqueues a recovery pass that already reconciles whatever `AgentDeliveryQueue` held
  across the previous process. When that launch's own recovery context has content
  (`recoveryHasContent` — a wake message, resume messages, or an unread summary), which is true for
  essentially every real relaunch of an Agent with something genuinely stuck behind a fence (by
  definition the server's own canonical unread ledger still shows it pending), `#dropSurvivingDeliveryQueue`
  discards the stale local queue entries and ACKs each one. This is safe for the same reason Stop's
  discard is not — ACKing a delivery marks only that this specific local delivery attempt was
  accepted, never that the message was read; the server's canonical unread/read boundary, which is
  what actually recovers the Agent's context on the new launch via `resumeMessages`/`unreadSummary`,
  is untouched by it. The fence's hold itself (the `#explicitHolds` flag) is *not* cleared by this
  reconciliation — deliberately, so the new launch inherits the same "stop delivering" state, per
  above.

The one theoretical gap this trace surfaces — a relaunch whose recovery context has no content at
all, `recoveryHasContent === false`, combined with something still sitting in `#held` — would hit
`#flushSurvivingDeliveryQueue`'s `idle(agentId)` call, which itself declines to drain while an
explicit hold is active (by `AgentDeliveryQueue.idle`'s own pre-existing contract). In practice this
cannot happen for a fenced Agent specifically: anything held locally implies a real pending delivery
the server also still has unread, so its recovery context is never empty. This gap already existed
in `AgentDeliveryQueue`'s design for an explicit hold generally (ADR 0048); this PR does not widen
it and the fence path cannot reach it.

**Verified, not merely assumed:** the brief's originating plan claimed Raft also fences an Agent
after 3 same-fingerprint failures, but flagged that anchor as unconfirmed. It is confirmed present:
`RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD = 3` (chunk line 30772, in the same constants block as
the delivery-backoff numbers), and the full fence machinery —
`noteRuntimeErrorFingerprintFence`/`applyRuntimeErrorFingerprintFence`/
`formatRuntimeErrorFingerprintFenceDetail` (chunk lines 12265-12271, 31201-31249) — matches this
PR's design: an `attempts` counter keyed by fingerprint, reset when the fingerprint changes,
tripping at the threshold, skipped entirely for an already-sticky-terminal or action-required
failure. This PR's own design (independently arrived at before finding the anchor, per the brief's
instruction to design first and verify after) turned out to match Raft's shape closely; the CoForge
divergences from it are recorded below.

#### State persistence: what actually clears the backoff streak and the fence

Both `RuntimeErrorDeliveryBackoff` and `RuntimeErrorFingerprintFence` are plain in-memory `Map`s
keyed by `agentId`, owned by `DaemonRuntime` itself (not by any per-launch record). Writing the
rule down rather than leaving it to be inferred from the `Map`'s lifetime:

- A genuinely successful turn (`completed`/`status: "completed"`) resets both.
- An explicit Stop (`#releaseAgentRuntime`) resets both and cancels any pending timer.
- **An unexpected process exit does not reset either one**, and **neither does any relaunch that
  follows it** (whether self-initiated after a crash or a fresh server-issued Start) — nothing in
  this PR clears them on that path. This is deliberate, not an oversight: the same underlying
  problem that built up a backoff streak, or tripped the fence, almost always persists across a
  bare process restart, and continuing to count/fence across it is what actually stops the "useless
  retry loop" this CR exists to close — resetting on every relaunch would let a permanently broken
  Agent burn a fresh 3-strike allowance every time it crashes and comes back. Only a human's
  explicit Stop is treated as "start over."

### 4. Spawn-failure cooldown: already delivered by PR #470, evaluated here

`packages/daemon/src/agent-runtime/launch-failure-backoff.ts` (`LaunchFailureBackoff`, used by
`AgentControl#attemptStart`) already implements this item, merged onto `main` immediately before
this branch's base commit (independently, not as part of this CR). Re-evaluated against this
brief's requirements:

- First spawn failure already enters cooldown (Raft's threshold 0): confirmed —
  `launchFailureCooldownMs` returns a real cooldown starting at `attempts === 1`.
- 1 s doubling, capped at 30 s: confirmed — `LAUNCH_FAILURE_BACKOFF_BASE_MS = 1_000`,
  `LAUNCH_FAILURE_BACKOFF_CAP_MS = 30_000`, matching Raft's `SPAWN_FAIL_BACKOFF_BASE_MS`/`_MAX_MS`
  (chunk line 30773-30774: `1e3` / `3e4`) exactly.
- State lives outside the per-launch record, surviving a Stop/Start cycle: confirmed — it is a
  field on `AgentControl` itself (`#launchFailures`), not on the control record `AgentControl`
  rewrites per launch; its own doc comment states this explicitly ("counted here rather than
  derived from the control record, so a superseding Stop/Start cannot reset the limiter").
- A successful spawn clears it: confirmed — `#onLaunchSucceeded` calls `#launchFailures.reset`.
- A longer cooldown for a credential/API-key-mint failure, the way Raft gives
  `RUNNER_CREDENTIAL_MINT_BACKOFF_BASE_MS`/`_MAX_MS` (60 s → 10 min, chunk line 30775-30777) a
  separate, longer schedule because Raft's inner mint loop
  (`RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS = 3`, chunk line 30706) has already retried 3 times before
  the outer spawn failure is even recorded: **not applicable today.** CoForge's own credential path
  (`DaemonRuntime#requestLaunchConfig`, a single `await` of `requestAgentLaunchConfig`/
  `requestAgentApiKey`) has no inner retry loop of its own — `stage: "credential" | "runtime"` in
  `#launchAgent` already distinguishes a credential-mint failure from a runtime-spawn failure for
  the *user-visible message* (`#launchFailureMessage`), but nothing today retries credential
  minting before that failure surfaces, so there is no "already retried 3 times" fact to justify a
  longer cooldown. The brief's own instruction was conditional ("If our credential/API-key mint
  path has its own retry…"); the condition is false, so this PR adds no differentiated cooldown for
  it and leaves the existing uniform `LaunchFailureBackoff` schedule covering both stages.
- Location: the brief suggested `AgentProcessManager` ("owns Agent availability and runtime
  processes") as the natural home. PR #470 instead put it on `AgentControl`. Evaluated and kept:
  `AgentControl#attemptStart` already owns the full retry *loop* (attempt scheduling, epoch/scope
  fencing against a superseding Stop/Start, the injectable `LaunchRetryScheduler`) that the
  cooldown number feeds directly into; `AgentProcessManager.start()` is a lower-level spawn
  primitive (one attempt, no scheduling, no retry, no knowledge of control epochs) that would have
  to reach back up into `AgentControl`'s scheduler to reuse a cooldown computed there. Keeping the
  cooldown on the module that already owns the retry loop it drives avoids that inversion.
- Bounded retries (`LAUNCH_FAILURE_MAX_ATTEMPTS = 7`, ~61 s total window) where Raft's own exponent
  is capped-but-otherwise-unbounded: an existing, already-documented CoForge decision from #470,
  restated here only because it is directly relevant to this CR's story — not re-litigated.

No code changes were made for this item; `packages/daemon/test/launch-failure-backoff.test.ts` and
`packages/daemon/test/agent-control-launch-retry.test.ts` (both pre-existing, both still green)
already cover it.

## Divergences from Raft

- **No HTTP status in the classifier.** Raft's `classifyRuntimeError(message, httpStatus)` takes an
  HTTP status and branches on 429/401/403/404/≥500 before falling through to text patterns.
  CoForge's `AgentRuntimeEvent` `"error"` shape (`packages/agent/src/contract.ts`) carries no status
  field, and no provider adapter measured for this PR (Claude Code, Codex, Cursor, Kiro, Pi) surfaces
  one on its `error` event today (Kiro's `providerErrorCode` is a JSON-RPC code, not an HTTP status).
  Adding an unused parameter/wire field to carry one would be speculative; `classifyRuntimeErrorText`
  only takes the message. If a provider later surfaces a real HTTP status, extend the table then —
  most of the status branches (429→rate limit, 401→auth, ≥500→server error) are already reachable
  through the equivalent text patterns.
- **Two-tier retry/terminal split, not Raft's three-tier terminal/sticky-terminal/ordinary split.**
  Raft's `classifyTerminalFailure`/`classifyStickyTerminalFailure` (chunk lines 13057-13087)
  distinguish "looks fatal but Raft still retries it" (e.g. a quota-exceeded or model-not-found
  *stderr line*, as opposed to this classifier's own `NotFoundError`/`ModelConfigError` *message*
  classes — different inputs) from "genuinely sticky" (action-required auth, input-too-large,
  unsupported model). That nuance is D's territory (terminal auth handling); this PR collapses it to
  a plain retry-or-not per class. The fence (item 3) is what actually keeps an always-retryable
  class like the generic fallback from looping forever on a failure that never clears, so the
  simplification does not reopen the "useless retry loop" problem this CR exists to close.
- **`errorClass` names are CoForge's own, chosen independently for the same underlying taxonomy**
  (rate limit, auth, timeout, connection, stream, server, not-found, input-too-large, model-config,
  launcher) — not copied from Raft's identifiers. Several read the same in English because there is
  no CoForge-specific synonym for "rate limit" or "timeout" that would not be confusing; no Raft
  source text, message, or comment was copied.
- **No `formatRuntimeErrorFingerprintFenceDetail`-style structured `state` object crossing a wire
  boundary.** Raft's fence detail is built from a lifecycle-record `state` object
  (`fingerprint`/`attempts`/`lastRuntimeError`/`detail`/`launchId`) that also carries `launchId` for
  cross-restart bookkeeping this PR does not need (the fence lives in memory for the process's
  lifetime, matching this PR's other new state — see below). CoForge's
  `RuntimeErrorFingerprintFenceState` is `{ fingerprint, attempts, fenced }` only.
- **No `AgentStatus` change on a fenced failure.** Raft's `applyRuntimeErrorFingerprintFence` also
  calls `sendAgentStatus(agentId, "inactive")` and `cleanupTerminalRuntimeFailure` (stopping the
  process). This PR deliberately does not: the underlying provider process may still be alive and
  mid-turn when the fence trips (an "error" event does not itself mean the process exited), and
  forcing `"inactive"` while it is still running would be exactly the untruthful state the brief
  warns against. Actually stopping the process on a fence trip is process-lifecycle surgery this
  brief's own scope note reserves for F (crash restart); this PR limits the fence's effect to the
  daemon's own delivery-backoff retry loop and the Activity that explains it.
- **No new `AgentActivityDetailKind`.** The fenced Activity reuses the existing `"runtime_error"`
  detail kind (an ordinary error-level Activity to any client that does not yet know about fencing)
  and distinguishes itself only through the existing `runtimeError.errorReason` string
  (`"runtime_error_fenced"`) — a value in an already-free-form field, not a wire shape change.
- **No injectable clock/scheduler on `DaemonRuntime`.** Raft's backoff timer is driven through its
  own injected clock abstraction throughout the daemon. `DaemonRuntime`'s constructor already has a
  long positional parameter list with no such seam, and every other per-Agent timer in
  `runtime.ts` (`#activityHeartbeatTimers`, the stdin/session-ready retry timers) uses the bare
  global `setTimeout` the same way; adding a new constructor parameter used by nothing else would
  be inconsistent with the rest of the file for one feature's sake. Tests use `bun:test`'s
  `jest.useFakeTimers()`/`jest.advanceTimersByTime`, the same pattern
  `activity-heartbeat.test.ts` already established for this exact class of timer.
- **`LaunchFailureBackoff` (item 4) already diverges from Raft's unbounded-but-capped exponent by
  bounding total attempts at 7 (~61 s window)** — a decision from #470, not from this PR, restated
  above only for completeness.

## Consequences

- A rate limit, a dead connection, or a provider server error now backs off and retries a held
  delivery automatically instead of the daemon silently doing nothing until the next unrelated
  wake; an auth failure, an oversized prompt, an unsupported model, a launcher failure, or a
  timeout does not retry at all, so the Agent's Activity feed stops implying a retry is coming when
  none is.
- An Agent whose runtime is stuck on the exact same failure stops burning a backoff cycle (up to
  5 minutes each) forever — it fences after 3 in a row, says so in one place in CoForge's own
  words, and stops receiving further deliveries entirely (not just further automatic retries)
  until a human explicitly Stops it, instead of either retrying at the cap indefinitely or (the
  bug an earlier revision of this PR had) delivering straight into the same broken runtime with no
  protection at all past the third failure.
- The spawn path (item 4) already had its own cooldown from #470; this PR's classification/backoff/
  fence machinery is a distinct layer (mid-turn runtime errors on an already-running process) that
  does not touch or duplicate it.

## Validation and rollback

- New unit suites: `packages/daemon/test/runtime-error-classification.test.ts` (13 tests),
  `packages/daemon/test/runtime-error-recovery.test.ts` (12 tests, pure backoff/fence bookkeeping).
- Updated: `packages/daemon/test/runtime-error-activity.test.ts` (the previous generic-default test
  now asserts real classification; one new test covers the still-generic fallback).
- New integration coverage in `packages/daemon/test/daemon-runtime.test.ts`, nested under the
  existing "Agent delivery queue (ADR 0048)" describe block (`"runtime-error delivery backoff and
  fingerprint fence (ADR 0055)"`, 7 tests): a retryable error holds and releases on schedule; a
  non-retryable error never holds; a successful turn resets the streak so a later failure starts
  at the base delay again; a failed (not completed) turn does not reset it; three same-fingerprint
  failures trip the fence and report `runtime_error_fenced`; **a fenced Agent stops delivering
  entirely — a further delivery is held, not notified, even long past what would have been the
  next backoff's release time, because nothing schedules one any more** (the regression test for
  the release-on-trip bug); an explicit Stop discards both streaks and cancels the pending timer.
- Rollback: revert this PR's commits. `AgentDeliveryQueue`'s `hold`/`release` seam and the wire
  `runtimeError` fields are unchanged by a revert (ADR 0048 already shipped them); no data
  migration, no wire-version bump.
