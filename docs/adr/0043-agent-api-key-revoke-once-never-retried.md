# ADR 0043: An Agent API key is revoked once, when its process is gone, and never retried

Status: accepted
Date: 2026-09-18
Supersedes: the pending-revoke retry in [ADR 0033](0033-agent-stop-outcome-and-control-repair.md)

## Context

On 2026-09-17 the Kiro Agent on Frank's Computer (daemon 0.1.0-dev.39) lost every message
operation with HTTP 401 from 16:46 UTC onward while its process kept running and the daemon's
cloud connection was healthy. The workspace daemon log shows the sequence: cloud reconnect at
16:11:33, `agent_api_key:revoke_failed` (timeout) at 16:11:44 for the _running_ Agent, two more
reconnects at 16:28 and 16:46, then `upstream_status: 401` on every `/api/agent/v1/messages`
request. Nobody had stopped or restarted the Agent.

ADR 0033 made the remote revoke best-effort so a failed revoke could not fail a Stop, and added
`#pendingAgentApiKeyRevokes`: a key entered that map at launch, left it only when a revoke
succeeded, and `#retryPendingAgentApiKeyRevokes` revoked every key in the map on the initial
ready pass, on every reconnect, and at shutdown. The key of a running Agent was therefore always
in the map, and the first reconnect after launch revoked it. The Agent's proxy binding keeps the
key it was issued at launch and has no refresh path, so the Agent stayed at 401 until restarted.

## Decision

Follow Raft Computer 1.0.32 exactly:

1. **Revoke happens once, at the moment the Agent process is gone**: process exit, Stop, or a
   launch that fails after the key was minted. Daemon shutdown counts as every process being gone
   and sends one revoke per running Agent.
2. **A failed revoke is logged (`agent_api_key:revoke_failed`) and nothing else happens.** There
   is no pending set, no retry on ready, reconnect or shutdown, and no state that survives the
   call.
3. **A reconnect never touches credentials.**
4. **The bound on a leaked key is the server's**: `PrismaAgentApiKeyRepository.replaceActive`
   revokes every earlier active key of the Agent in the transaction that mints the next one.

`#stop()` recreates the transport unconditionally after `.stop()`; the conditional reuse ADR 0033
added existed only to give the retry an authenticated transport.

## Comparison with Raft Computer 1.0.32

Behaviour read from the shipped 1.0.32 daemon bundle; no code was copied.

- `mintRunnerCredential` mints one runner credential per `agent:start`; the key and its id live
  in the process record (`ap.config`) and nowhere else.
- `revokeManagedRunnerCredential` is called from exactly five places, all of them "this process
  is gone": process exit, explicit Stop, runtime start failure, terminal failure, and the
  silent internal stop. It `void`s a `DELETE …/credentials/<id>`, records a
  `daemon.runner_credential.revoke` trace with the status or the error, and keeps no state.
- The WebSocket `open` handler resets backoff, flushes queued session invalidations and
  activity, and calls `onConnect`, whose only consumer is the local schedule runtime. It does
  nothing with credentials.
- A server-initiated restart that rebinds the same process to a new `launchId` carries the
  existing credential over unchanged; it neither mints nor revokes.

## Rejected alternative

Keep the pending set but only add a key when a revoke is actually owed (exit, Stop, launch
failure). This fixes the incident and keeps the retry ADR 0033 wanted. Rejected because Raft
has no such concept and accepts the same window; a concept the reference lacks is removed, not
kept.

## Consequences

- The window ADR 0033 described under "A revoke can lag" still exists and is now bounded only by
  the server's `replaceActive` at the Agent's next launch, the same bound Raft relies on.
- A running Agent can no longer lose its key to the daemon. The only ways a key stops working
  are the Agent's own stop/exit, a new launch of the same Agent, or a server-side revoke.
- `daemon-runtime.test.ts`: a reconnect pass with a running Agent sends no revoke; a revoke that
  fails at Stop is attempted exactly once across later reconnects; shutdown sends one
  authenticated revoke per running Agent and always recreates the transport.

## Validation and rollback

Validated by the tests above and by the incident log pattern: after this change the daemon never
sends a revoke for an Agent that has a current launch. Rollback is reverting the commit; nothing
persistent changes.
