# ADR 0035: Full Reset never latches — a workspace clear failure is non-fatal

Status: accepted
Date: 2026-09-17

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

## Decision

**A. A workspace clear failure is non-fatal.** `AgentControl.resetWorkspace` no longer treats a
`clearWorkspace()` rejection as a reason to fail the operation. It logs the failure at error
level with a stable `event: "agent_control:workspace_clear_failed"` and `error_code:
diagnosticErrorCode(error)` (the same helper ADR 0033 introduced for `AgentControl`'s other
diagnostics), still calls `this.sessions.clear(record)` to drop the local session association
exactly as the success path does, and reports the primitive result as `phase: "workspace-reset"`
— never `"failed"` — carrying a new optional `warningCode: "workspace_clear_incomplete"` instead
of `errorCode`. The control chain proceeds to Start exactly as it would after a clean clear.

**B. The new `warningCode` is a dedicated, additive wire field — never an overload of
`errorCode`.** `AgentControlResult` (`packages/coforge-sdk/proto/coforge/rpc/v1/agent_control.proto`,
field 14; mirrored in `packages/coforge-sdk/src/internal/agent-control.ts`) gains
`optional string warning_code`, validated with the same safe-code pattern as `error_code`. The
server's `AgentControlState` (`apps/web/src/server/agents/agent-control.server.ts`) and its zod
`stateSchema` (`apps/web/src/server/db/repositories/agent-control.repositories.server.ts`) gain a
matching optional `warningCode`; existing rows without the key still parse. `result()` carries a
result's `warningCode` onto the state and, unlike `errorCode` (which is deliberately dropped and
only reset from the newest result), lets it survive through `fields`'s spread across `advance()`'s
chain steps so it is still visible once the chain's later `start` result completes the operation —
a `workspace-reset` step's warning must still be on the `AgentControlView` the owner eventually
sees, even though the `started` result that follows carries no warning field of its own. An old
server that has not deployed this field simply never reads it off an incoming result (protobuf
leaves an unset optional field absent, and an old client/server pair round-trips every other field
unaffected — the same forward/backward compatibility every other optional field on this message
already relies on). The existing invariant that a `workspace-reset` result must never carry
identity (`"Reset retained old Session"`) is untouched; `warningCode` and `errorCode` are never
set on the same result.

**C. Both control-layer latches are removed.**

- Daemon `start()`'s rejection condition for a `"failed"` record narrows from
  `record.phase === "failed" && (record.scope.epoch === scope.epoch || record.action ===
  "reset-workspace")` to `record.phase === "failed" && record.scope.epoch === scope.epoch`. The
  ordinary same-epoch "this exact retry hasn't completed" rule is unchanged for every action; only
  the reset-workspace-specific clause that ignored epoch entirely is gone. A record a pre-ADR-0035
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

**D. A partial clear no longer stops early.** `FileAgentRuntimeStateStore.clearWorkspace`
(`packages/daemon/src/persistence/agent-runtime-state-store.ts`) now `try`/`catch`es each entry's
`rm` inside the loop, continuing past a failing entry and collecting only the *first* error, then
throwing that error once every entry has been attempted. One undeletable file (or directory) no
longer leaves every entry after it in place; the caller (`AgentControl.resetWorkspace`, decision
A) still sees a rejection and still turns it into the same warning.

**E. Two deliberate divergences from Raft are kept, and are not latches.**

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

## Consequences

- **A clear failure is now always visible, never silent.** The old code's `catch {}` produced no
  log line at all when a clear failed; the new code always logs
  `agent_control:workspace_clear_failed` at error level with a diagnosable `error_code`. This is
  the same "error level because a repair/non-fatal path must never become an unobserved normal
  path" reasoning ADR 0033 applied to its stale-record repair.
- **The owner is told, not just the operator.** The new `warningCode` reaches
  `AgentControlView.warning` and the Web UI (`apps/web/src/features/agents/agent-control.tsx`)
  renders it as an inline notice in the same panel the existing submit-failure text already uses
  — never a toast, never a raw code (`docs/adr/0021`... — actually see the toast-vs-inline
  convention already in force across the product: a toast is an action confirmation only,
  anything the user must see or act on stays inline).
- **A legacy on-disk record is not a permanent liability.** A daemon record left by a pre-ADR-0035
  build in `phase: "failed"`, `action: "reset-workspace"` is handled by the narrowed same-epoch
  check like any other failed action, not specially fenced forever; there is no data migration and
  no manual cleanup required — the very next Start at a newer epoch already succeeds.
- **`AgentControlResult.warningCode` and `AgentControlState.warningCode` are new, optional, purely
  additive fields.** No wire or schema migration is required in either direction; an old daemon
  never sends the field, an old server never reads it, and existing `controlState` JSONB rows
  without the key parse unchanged.
- Nothing here changes the command chain shape, the request/epoch/CAS fencing, the
  `confirmed_stop_required` precondition, or ADR 0033's stale-record repair; `docs/architecture.md`
  and `CONTEXT.md`'s Full Reset description are updated in the same change to drop the "deletion
  failure forbids start" and "explicit retry" language they previously carried.

## Validation and rollback

Covered by `packages/daemon/test/agent-control.test.ts` (a clear failure reports
`workspace-reset` with `warningCode: "workspace_clear_incomplete"`, clears the session, logs
`agent_control:workspace_clear_failed` at error level, and Start still proceeds; a newer Start
still cannot bypass an in-progress `"clearing"` deletion; a pre-existing `"failed"`
reset-workspace record from an older daemon no longer blocks a newer-epoch Start;
`confirmed_stop_required` is still enforced), `packages/daemon/test/agent-runtime-state-store.test.ts`
(a partial clear continues past one undeletable entry and still removes the rest),
`packages/coforge-sdk/src/internal/agent-control.test.ts` (the new field round-trips, is validated
with the same safe-code shape as `errorCode`, and a payload with no warning-code field at all —
an old daemon's result — decodes cleanly without it), and
`apps/web/test/agent-control.test.ts`/`agent-control-runtime.test.ts` (Full Reset completes with a
warning and a fresh session when the clear fails; after any failed operation — including a legacy
bare-`"failed"` reset-workspace result — start, stop, restart, reset-session, and full-reset may
all begin immediately; the still-pending-operation rule is unchanged; a legacy `controlState` row
without `warningCode` still parses). Rollback is by revert; every schema and wire change here is
additive.
