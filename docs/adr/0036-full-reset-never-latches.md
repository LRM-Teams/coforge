# ADR 0036: Full Reset never latches

Status: accepted
Date: 2026-09-17 (amended 2026-09-17: dropped the `warningCode` wire field after product review;
also removes ADR 0035's full-reset-only abandoned-operation exception — see "Relationship to ADR
0035"; amended again 2026-09-17 by [ADR 0039](0039-agent-control-latest-command-wins.md) — see the
note below)

> **Amendment (2026-09-17, ADR 0039):** Decision E and "Relationship to ADR 0035" below describe
> an *abandoned* pending Full Reset yielding to any competing action. ADR 0039 removed the
> abandonment concept itself (`updatedAtMs`/`abandonAfterMs`): every pending Full Reset — not only
> one nobody is driving any more — now yields to any competing action, at every chain phase,
> unconditionally. The conclusion these sections reach (no full-reset-only exception; the Daemon's
> own `previous_control_not_completed`/`confirmed_stop_required` checks are the real protection)
> still holds and is restated in ADR 0039 itself; only the trigger ("abandoned" vs. "any pending
> operation") changed.

## Context

ADR 0033 fixed a class of Agent lifecycle wedges caused by treating a *remote* failure (a
credential revoke) as a *local* Stop failure, and by letting a stale control record fence a
daemon forever instead of being repaired. This ADR closes the same family of bug for the
remaining wedge the product owner's rule — "liveness over durable receipts: an Agent must
never latch into a state only a special action can leave" — flags in Full Reset's own workspace
clear step, and removes the latches that step could still leave behind even after ADR 0033.

Reading the extracted Raft Computer 1.0.32 bundle for design only (never copied; see
`docs/agents/reference-cli-research.md`), `resetWorkspace` (`bundle.cjs:845825–845833`) `rm -rf`s
the Agent directory and, on failure, only logs an error — there is no result, no state, and
nothing blocks a later `agent:start`. CoForge's Full Reset diverged from this in three ways that
each let a failed clear become a permanent wedge:

1. **Daemon `resetWorkspace()`** (`packages/daemon/src/agent-runtime/agent-control.ts`): a
   `clearWorkspace()` failure wrote the control record's `phase` as terminal `"failed"` with
   `errorCode: "workspace_clear_failed"`, and the failure was silently swallowed (`catch {}`,
   no log at all).
2. **Daemon `start()`**: a record with `phase === "failed"` and `action === "reset-workspace"`
   was rejected with `previous_control_not_completed` regardless of the request's epoch — not
   just at the same epoch (the ordinary "this specific retry hasn't completed yet" rule that
   still applies to every other failed action), but forever, across every later epoch, until an
   operator intervened by hand.
3. **Server `begin()`** (`apps/web/src/server/agents/agent-control.server.ts`): after any failed
   `full-reset`, every action except another `full-reset` was rejected with `"Explicit Agent
   reset retry is required"`; and after `errorCode === "workspace_clear_failed"` specifically,
   even a `full-reset` retry could not reach `start` again on any path that wasn't itself a fresh
   `full-reset`. An Agent whose workspace happened to contain one file the daemon's OS user could
   not delete (a root-owned leftover, a permission mismatch, a file the provider still had open)
   was stuck until a human found and explicitly retried Full Reset — not merely inconvenienced,
   but *unstartable* by every other button on the page.

`packages/daemon/src/persistence/agent-runtime-state-store.ts`'s `clearWorkspace` compounded
this: it deleted each workspace entry in a plain `for` loop with no `try`/`catch` around the
`rm`, so the *first* undeletable entry stopped the loop outright and left every entry after it
untouched, even though most of a workspace is usually perfectly deletable.

**Amendment context (product review):** an earlier version of this ADR additionally introduced a
dedicated `warningCode` wire field so the owner could be told inline in the Web UI that a clear
had not fully finished. After review, the product owner decided to follow Raft 1.0.32 exactly
here instead: Raft's `resetWorkspace` only logs the failure — there is no result field and the
user is told nothing. This revision removes `warningCode` completely, keeping only the
non-latching behavior. See "Rejected alternatives".

The same review also revisited ADR 0035 (#321)'s "an abandoned Full Reset yields only to a new,
explicitly confirmed Full Reset" exception (see "Relationship to ADR 0035" below) and removed it.

## Decision

**A. A workspace clear failure is non-fatal, and logged only — matching Raft exactly.**
`AgentControl.resetWorkspace` no longer treats a `clearWorkspace()` rejection as a reason to fail
the operation. It logs the failure at error level with a stable
`event: "agent_control:workspace_clear_failed"`, `error_code: diagnosticErrorCode(error)` (the
same helper ADR 0033 introduced for `AgentControl`'s other diagnostics), and the `request_id`/
`workspace_id`/`computer_id`/`agent_id` already in scope (`outcome: "failed"`, per
`docs/observability.md`'s rule for an `error`-level log). It still calls `this.sessions.clear(
record)` to drop the local session association exactly as the success path does, and reports the
primitive result as plain `phase: "workspace-reset"` — never `"failed"`, and with no extra field
of any kind. The control chain proceeds to Start exactly as it would after a clean clear. There is
no result field, database column, or protobuf field for this outcome anywhere on the wire — the
daemon operator's structured log is the only record of it, exactly like Raft's own `catch`-and-log.

**B. Both control-layer latches are removed.**

- Daemon `start()`'s rejection condition for a `"failed"` record narrows from
  `record.phase === "failed" && (record.scope.epoch === scope.epoch || record.action ===
  "reset-workspace")` to `record.phase === "failed" && record.scope.epoch === scope.epoch`. The
  ordinary same-epoch "this exact retry hasn't completed" rule is unchanged for every action; only
  the reset-workspace-specific clause that ignored epoch entirely is gone. A record a pre-ADR-0036
  daemon left in `"failed"` with `action: "reset-workspace"` no longer blocks a newer-epoch Start
  — see the "pre-existing failed reset-workspace record from an older daemon" test.
- Server `begin()` drops its `old?.phase === "failed" && old.action === "full-reset" && (action
  === "start" || (old.errorCode === "workspace_clear_failed" && action !== "full-reset"))` branch
  entirely. The only remaining precondition on beginning a new operation is the pre-existing,
  unrelated "an operation still in flight blocks a new one" rule
  (`old && !terminal(old)`) — once an operation is terminal (`"completed"` or `"failed"`, for any
  reason, including a legacy daemon's bare `"failed"` reset-workspace result, which the server
  still accepts and represents as a terminal failure for diagnostic purposes even though this
  daemon will never produce one again), every action — start, stop, restart, reset-session,
  full-reset — may begin. No UI copy referenced the removed error text directly (the button's
  generic submit-failure message covered it), so no user-facing string needed to change for this
  part.

**C. A partial clear no longer stops early.** `FileAgentRuntimeStateStore.clearWorkspace`
(`packages/daemon/src/persistence/agent-runtime-state-store.ts`) now `try`/`catch`es each entry's
`rm` inside the loop, continuing past a failing entry and collecting only the *first* error, then
throwing that error once every entry has been attempted. One undeletable file (or directory) no
longer leaves every entry after it in place; the caller (`AgentControl.resetWorkspace`, decision
A) still sees a rejection and still turns it into the same log-only outcome.

**D. Two deliberate divergences from Raft are kept, and are not latches.**

- `confirmed_stop_required` (`AgentControl.resetWorkspace`'s check that a prior Stop's receipt is
  `"stopped"` and the process is not observed running) stays. Raft does not check this — it
  simply `rm -rf`s the Agent directory unconditionally, alongside its in-memory-only Agent table
  with no equivalent of an unconfirmed process. Deleting a workspace out from under a running
  process is unsafe on both of CoForge's target platforms regardless of what a subsequent Start
  would do, so this check is not something liveness-over-durable-receipts argues for removing.
  It costs nothing on liveness after ADR 0033: a failed Stop can simply be retried (`AgentControl`
  will begin a fresh Stop; ADR 0033 made Stop's outcome the local process exit alone, so a retry
  is reliable), and once that Stop succeeds, Full Reset proceeds.
- `clearWorkspace` deletes the workspace directory's *contents*, not the directory itself,
  keeping the `noLinkedAncestors` symlink-ancestor guard. Raft instead removes the whole Agent
  directory and lets it be recreated at the next start. The outcomes are equivalent — an empty
  Agent workspace either way — and CoForge's guard depends on being able to `lstat` a stable path
  before every operation; there is no liveness cost to keeping this shape, so it is unchanged.

**E. ADR 0035's full-reset-only abandoned-operation exception is removed.** `begin()`
(`apps/web/src/server/agents/agent-control.server.ts`) no longer special-cases `action ===
"full-reset"` when superseding an abandoned, non-terminal operation. An abandoned Full Reset
caught in any of its chain phases (`stopping`, `clearing`, `starting`) is now superseded by *any*
next action — start, stop, restart, reset-session, or a fresh full-reset — exactly like every
other abandoned operation: epoch + 1, identity handling and the `agent_control:pending_superseded`
log unchanged. A **non-abandoned** (fresh) pending operation still blocks a competing action
regardless of its action, full-reset included — that rule is untouched. See "Relationship to ADR
0035" for why the exception existed and why it no longer needs to.

## Rejected alternatives

- **A dedicated `warningCode` wire field, surfaced as an inline Web UI notice.** An earlier
  version of this ADR shipped this (a new `AgentControlResult.warning_code` protobuf field,
  mirrored on `AgentControlState`/`AgentControlView`, rendered inline in
  `apps/web/src/features/agents/agent-control.tsx`). Rejected on product review: it is not part of
  Raft's behavior (Raft only logs), it required a wire/schema change for a non-fatal diagnostic,
  and it was invisible in the most common case anyway — `AgentControl.execute()`'s `drive()`
  waiter times out after 7 s and returns whatever `AgentControlView` is available at that instant;
  if the Daemon's `workspace-reset` result (carrying the warning) had not yet arrived, the browser
  received a plain `"pending"` view with no warning and no subsequent poll to pick one up later.
  Removed completely rather than reserved on the wire, since it never shipped to any release.
- **Keeping the daemon/server latches described in Context.** Rejected as the core problem this
  ADR fixes: an Agent must never become unstartable because of a non-fatal cleanup failure.
- **Dropping `confirmed_stop_required`.** Rejected; see Decision D above — deleting a workspace
  out from under a running process is unsafe regardless of what liveness-over-durable-receipts
  argues for, and the check costs nothing on liveness once Stop itself is reliably retryable
  (ADR 0033).
- **Keeping ADR 0035's "abandoned full-reset yields only to a new full-reset" exception.**
  Rejected on the same product review that removed `warningCode`: Raft keeps no operation state
  on the wire or on disk at all, so there is no equivalent protection to preserve by keeping a
  CoForge-only exception; the exception protected nothing the Daemon does not already protect on
  its own (`start()` still refuses to launch while its own record is `"clearing"`, and
  `resetWorkspace()`'s `confirmed_stop_required` still guards the clear itself, so a workspace can
  never be started against or deleted out from under a live process because of this removal); and
  every action able to actually supersede a stuck operation already carries its own authorization
  check (for example Restart needs only `controlAgentRuntime`, held by any member, while Full
  Reset itself needs `resetAgentWorkspace`), so removing the exception does not let an
  under-privileged actor reach a capability they lack — it only lets a *different*, already
  self-authorizing action clear a stuck Full Reset instead of being permanently blocked by it.

## Consequences

- **A clear failure is now always visible to an operator, never silent.** The old code's
  `catch {}` produced no log line at all when a clear failed; the new code always logs
  `agent_control:workspace_clear_failed` at error level with a diagnosable `error_code` and the
  request/workspace/computer/agent ids already in scope. This is the same "error level because a
  repair/non-fatal path must never become an unobserved normal path" reasoning ADR 0033 applied to
  its stale-record repair.
- **The Agent owner is told exactly what Raft tells them: nothing.** Matching Raft 1.0.32
  precisely, a clear failure that could not remove every file is invisible on the wire and in the
  Web UI; only the Daemon's structured log records it. There is no inline notice, no toast, and no
  new field for a human operator to read off the product UI — diagnosis is an operator/log task,
  not a product-surface one.
- **A legacy on-disk record is not a permanent liability.** A daemon record left by a pre-ADR-0036
  build in `phase: "failed"`, `action: "reset-workspace"` is handled by the narrowed same-epoch
  check like any other failed action, not specially fenced forever; there is no data migration and
  no manual cleanup required — the very next Start at a newer epoch already succeeds. The same is
  now true of an abandoned pending Full Reset left by any daemon (decision E): it is superseded
  like any other stuck operation, never specially fenced.
- **No new wire, database, or protobuf field exists anywhere in this ADR.** `AgentControlResult`,
  `AgentControlState`, `AgentControlView`, and the `controlState` JSONB schema are unchanged from
  before this ADR (the `warningCode` field this ADR originally added was removed before shipping;
  see "Rejected alternatives"). A mixed-version deployment needs no forward/backward compatibility
  handling for this change: an old and new daemon/server pair round-trip identically to before this
  ADR existed.
- Nothing here changes the command chain shape, the request/epoch/CAS fencing, or
  `confirmed_stop_required`; `docs/architecture.md` and `CONTEXT.md`'s Full Reset description are
  updated in the same change to drop the "deletion failure forbids start", "explicit retry", and
  "abandoned full-reset yields only to full-reset" language they previously carried, replacing it
  with "a clear failure is logged by the Daemon and the operation still completes with a fresh
  session."

## Validation and rollback

Covered by `packages/daemon/test/agent-control.test.ts` (a clear failure reports plain
`workspace-reset`, clears the session, logs `agent_control:workspace_clear_failed` at error level
with `outcome: "failed"` and the request/workspace/computer/agent ids, and Start still proceeds; a
newer Start still cannot bypass an in-progress `"clearing"` deletion; a pre-existing `"failed"`
reset-workspace record from an older daemon no longer blocks a newer-epoch Start;
`confirmed_stop_required` is still enforced even right after a non-fatal clear failure, at a new
epoch with no fresh Stop),
`packages/daemon/test/agent-runtime-state-store.test.ts` (a partial clear continues past one
undeletable entry and still removes the rest), `packages/coforge-sdk/src/internal/agent-control.
test.ts` (no `warningCode`-related codec behavior exists to test; the message shape is unchanged
from before this ADR), and `apps/web/test/agent-control.test.ts`/`agent-control-runtime.test.ts`
(Full Reset completes with a fresh session and no warning field when the clear fails; `recover()`
— the ready-recovery auto-start path — now proceeds after a terminal failed full-reset instead of
being rejected; after any failed operation — including a legacy bare-`"failed"` reset-workspace
result — start, stop, restart, reset-session, and full-reset may all begin immediately; the
still-pending-operation rule for a **fresh** operation is unchanged; an **abandoned** Full Reset
caught in `"stopping"`, `"clearing"`, or `"starting"` is superseded by restart, reset-session,
full-reset, stop, and start alike, each with epoch+1 and the `agent_control:pending_superseded`
log). Rollback is by revert; this ADR removes fields and branches rather than adding any, so a
revert only reintroduces the previous (already-shipped-to-review, never-released) behavior.

## Relationship to ADR 0035

ADR 0035 (#321) landed while an earlier version of this change was in review. It introduced
abandonment-based superseding of a stuck pending operation, with one exception: an abandoned Full
Reset yielded only to a new, explicitly confirmed Full Reset, because its workspace deletion might
be half done. This ADR originally kept that exception unchanged, removing only the latches that
followed a *terminal* failure (Raft has no equivalent of either the abandonment-supersede
mechanism or this exception, since it keeps no operation state at all).

After further product review, that exception is removed too (Decision E above). Reasoning:

- Raft keeps no operation state on the wire or on disk, so there is no Raft-equivalent protection
  this exception was preserving — it was a CoForge-only rule from the start.
- The exception protected nothing the Daemon does not already protect on its own: `start()`
  (`packages/daemon/src/agent-runtime/agent-control.ts`) still refuses to launch while its own
  record's phase is `"clearing"`, at any epoch, and `resetWorkspace()`'s `confirmed_stop_required`
  still guards the clear itself. A workspace can be neither started against nor deleted out from
  under a live process because of this removal.
- Every action able to actually supersede a stuck operation already carries its own authorization
  check (`EXECUTE_CAPABILITY` in `agent-control.server.ts`): Restart and Reset Session need only
  `controlAgentRuntime`, held by any current Workspace member; Full Reset itself needs
  `resetAgentWorkspace`, owner/admin only. Removing the exception does not let an under-privileged
  actor reach a capability they lack — it lets a different, already self-authorizing action clear
  a stuck Full Reset instead of being permanently blocked by it, which is exactly the liveness
  problem this whole ADR exists to fix.

See the dated amendment note on ADR 0035's exception paragraph (point 3 of its Decision) for the
cross-reference back from that record.
