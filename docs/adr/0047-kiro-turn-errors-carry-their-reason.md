# ADR 0047: A Kiro turn's error carries its real reason, scrubbed; a failed turn shows exactly one

Status: accepted
Date: 2026-09-18

## Context

On 2026-09-18 a Kiro Agent's turn ended with ACP `stopReason: "error"`. Kiro's own session file
recorded exactly why — a `displayError` of `ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC` /
"decryption failed or bad record mac" — but the Agent's Activity showed only "Kiro reported a
runtime error" (mid-turn) and then "Kiro request failed" would have shown for a `session/prompt`
rejection. Both are hard-coded strings that discard the fact Kiro sent, on purpose, per the
existing code comments in `packages/daemon/src/code-agent/kiro/provider.ts`:

- `session/prompt` rejection → `error` event `"Kiro request failed"` (native error text dropped).
- ACP `session_info_update` with `_meta.kiro.kind === "error"` and a `message` → `error` event
  `"Kiro reported a runtime error"` (native `message` dropped).

Neither choice was ever recorded as its own ADR (`docs/adr` has only 0010, Kiro's original v3 ACP
integration; it does not mention dropping native error text) — the "drop it outright" decision
lived only in those two code comments. This ADR is therefore a new decision, not a supersession.

Separately, a turn Kiro cancels on its own (`stopReason: "cancelled"` without the daemon ever
calling `interrupt()`) was shown as a silent `"interrupted"`, indistinguishable from a requested
Stop. And a failed turn that already showed its own `runtime_error` Activity (the `error` event
above) still got a second, generic `"Agent runtime failed."` Activity from
`daemon-runtime/runtime.ts`'s `completed`/`failed` handling — two Activities, neither the specific
one very informative, for one failed turn.

`packages/agent/src/contract.ts`'s `AgentRuntimeEvent` already has a `type: "error"` shape carrying
`message`, plus optional `providerErrorCode`/`providerErrorClass`/`providerErrorReason`; the daemon
core already has one shared conversion for every provider's error/crash text
(`agent-runtime/runtime-error-activity.ts`'s `scrubRuntimeErrorText`, reused by `runtime.ts`'s
`scrubActivityText`) and one shared cap (512 characters). Kiro was the one provider that never
used either — it manufactured a fixed string instead of forwarding (scrubbed) fact.

## Decision

1. **Forward Kiro's own reason, scrubbed, not a placeholder.** `session_info_update`'s
   `_meta.kiro.message` (confirmed against the fixtures/measured frames: a plain string, alongside
   an optional `errorType` stable code such as `ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC`) is
   run through the existing `scrubRuntimeErrorText` (redaction + the same 512-char cap every other
   runtime error uses) and emitted as the `error` event's `message`; `errorType`, when present,
   becomes `providerErrorCode`. A `session/prompt` JSON-RPC rejection forwards its own `message`
   the same way, plus the JSON-RPC `code` as `providerErrorCode` when it is a number. No new
   scrubber was written.
2. **A turn's stop reason always ends in exactly one visible reason.** `KiroSession` now tracks
   the last scrubbed reason a `session_info_update` volunteered for the turn in progress
   (`#turnErrorMessage`, reset at the start of every prompt). When the `session/prompt` response
   resolves:
   - `end_turn` → `completed: "completed"` (unchanged).
   - `cancelled` while the daemon itself requested it (`#interrupting`) → `completed: "interrupted"`
     (unchanged) — a requested Stop is not an error.
   - `cancelled` when the daemon never asked (Kiro cancelled its own turn) → an `error` event
     (`"Kiro cancelled the turn"` if nothing more specific was already shown this turn) then
     `completed: "failed"`. This was previously shown as a silent `"interrupted"`.
   - `error`, `max_tokens`, `max_turn_requests`, `refusal`, or any other value the CLI sends
     (Kiro's `"error"` value is not in ACP's own `StopReason` union, so it is handled as one of the
     "otherwise failed" cases, matching the existing broad `: "failed"` fallback) → an `error`
     event naming the reason (or the CoForge-worded fallback for that reason) then
     `completed: "failed"`.
   In every failed/cancelled case, if `#turnErrorMessage` was already shown for this turn (the
   `session_info_update` fired before the stop reason arrived — the exact shape of the incident),
   no second `error` event is emitted; the one already shown stays the one visible reason.
3. **The daemon core keeps that promise for every provider, not just Kiro.**
   `daemon-runtime/runtime.ts`'s `completed`/`failed` handling built a fixed `"Agent runtime
   failed."` Activity unconditionally. It now skips that generic Activity when `launch.crashDetail`
   is still set (an `error` event was already turned into its own `runtime_error` Activity this
   turn) — the specific reason stays the one visible reason instead of a second, uninformative one
   layered on top. This is provider-neutral: every adapter's `error`-then-`completed(failed)` pair
   (Codex's turn-failure path included) now reports once, not because Kiro is special-cased, but
   because the shared completion handler is.

## Comparison with Raft Computer 1.0.32

Raft has no Kiro provider (per `docs/agents/reference-cli-research.md`'s existing note). The
closest structural analog in the recovered 1.0.32 daemon bundle is its own ACP-based provider
("Grok Build"), whose event normalizer (`GrokEventNormalizer.finishPrompt`, ~837962-838003)
converts a resolved `session/prompt`'s stop reason exactly this way:

```
if (stopReason === "error") events.push({ kind: "error", message: agentResult ?? "Grok Build turn failed" });
else if (stopReason === "cancelled") events.push({ kind: "error", message: agentResult ?? "Grok Build turn was cancelled" });
events.push({ kind: "turn_end", ... });
```

— an `error` event with the agent's own result text or a fixed fallback for `"error"`, and
**always** an `error` event for `"cancelled"` too, before the turn ends. This is the shape Do item
3 in the originating task brief is matched against.

One divergence, found while checking: Raft's Grok driver declares `communication.runtimeControl:
"none"` — it has no mid-turn interrupt/cancel capability at all; a Stop there kills the process
rather than sending `session/cancel`. Every `"cancelled"` stop reason Grok's normalizer sees is
therefore, by construction, Kiro's own decision, never a daemon-requested one — Raft's normalizer
has no `#interrupting`-equivalent gate because it has nothing to gate. CoForge's Kiro adapter does
support a real mid-turn `interrupt()` (`session/cancel`), so it needs, and has, that gate; Raft's
unconditional "cancelled → error" is the right shape only for the *unrequested* half of CoForge's
two cases.

Every runtime error's redaction/cap/fingerprint is built once, centrally, matching Raft's own
`buildRuntimeErrorDiagnosticEnvelope` (~821014-821030, itself built on
`scrubRuntimeErrorDiagnosticText`, ~821115-821128, and `MAX_RUNTIME_ERROR_MESSAGE_EXCERPT_CHARS`) —
CoForge's pre-existing `agent-runtime/runtime-error-activity.ts` already has the equivalent single
conversion (`scrubRuntimeErrorText`, `fingerprintRuntimeError`, the 512-char cap); this ADR makes
Kiro use it instead of discarding text before it ever reaches that conversion. Raft's own activity
builder (~847943-848033) additionally classifies terminal/sticky failures, gates steering, and can
stop the runtime process for an auth error — none of that is in scope here; CoForge's existing
`runtimeError.errorClass`/`errorReason`/`fingerprint` classification is unchanged by this ADR.

## Rejected alternative

Keep discarding Kiro's native text and instead improve only the fixed fallback strings. Rejected:
the whole point of the incident is that Kiro *told us* the real reason
(`ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC`) and CoForge threw it away; a better fallback still
has nothing to say when Kiro does have something to say.

## Consequences

- A Kiro turn error (mid-turn or a `session/prompt` rejection) shows Kiro's own scrubbed diagnostic
  instead of a generic sentence, matching how every other provider's `error` event already works.
- A turn Kiro cancels on its own is now visibly a failure with a reason, not a silent
  interruption; a requested Stop is unchanged.
- A failed turn shows exactly one Activity for its one reason, for every provider, not two.
- Out of scope (unchanged): the mid-turn `session/prompt` that makes Kiro cancel its own turn to
  steer a busy session (ADR 0010) — moving that into daemon-side delivery gating is separate work.
  `notify`/`sendMessage` semantics are unchanged.

## Validation and rollback

`packages/daemon/test/kiro-agent-adapter.test.ts` (real ACP frame shapes via
`test/fixtures/kiro-acp.ts`): a `session_info_update` error carries its scrubbed text and
`errorType` through as one `error` event; a `session/prompt` rejection forwards its own scrubbed
message and JSON-RPC code; `stopReason: "error"` with and without an observed cause; an unrequested
`"cancelled"` reports failed-with-a-reason, not interrupted; a requested interrupt still reports no
error; `max_tokens` names the stop reason. `packages/daemon/test/daemon-runtime.test.ts`: a failed
turn that already showed its own `runtime_error` Activity emits no second, generic failure
Activity; a failed turn with no prior `error` event still gets the generic one. Rollback is
reverting this commit; no persisted state or wire contract changes.
