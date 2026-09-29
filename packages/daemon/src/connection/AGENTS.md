# connection instructions

Rules for the Workspace cloud connection in `src/connection/`. They extend
`packages/daemon/AGENTS.md`.

## Boundary

- This directory owns the daemon's long-lived WSS connection, ordered replay,
  reconnect, and protocol transport mechanics. Domain decisions stay in
  `daemon-runtime/` and below.
- `built-server.ts` supplies the build-inlined server and WSS endpoint. Do not
  read them from anywhere else.
- A Centrifugo disconnect whose code and reason name a
  `DaemonConnectRejectionReason` is a refusal for good: it rejects a pending
  `start`, or reaches `onConnectionRefused` once the connection was up. The
  connection only classifies it; stopping Agents and parking belong to
  `daemon-runtime/` and `supervisor/workspace-parking.ts`.
- centrifuge-js retries a failed attempt itself (a temporary connect error, or
  a transport that closed before it opened) and reports it as `error`. It
  emits `disconnected` only once it has given up. A give-up that is not a
  refusal (a non-temporary connect error, a server code in 3500-3999, a
  message over the size limit) is resumed by the connection after its own
  1 s to 30 s doubling backoff; a disconnect it asked for itself (code 0) is
  not. Add no other retry loop.
- The first connect follows the same rules: `start` settles only on
  connecting, a refusal, `stop`, or its `signal` aborting. A stop or abort
  rejects with `DaemonConnectionStoppedError`, so callers tell a deliberate
  stop from a failure by type.
- Failed attempts log `daemon_connection:retry_scheduled` (`retry_by` client
  or daemon) at warning; a run of them escalates to error, like ready retries.
- An outage ends only once a connection proved stable: its ready accepted and
  60 s up (`STABLE_CONNECTION_MS`), checked at the next failure or reconnect.
  A connection dropped sooner continues the outage (backoff, attempt count,
  escalation); a reconnect never restarts the ready retry count either.
- `connectFailure()` is what status and the handshake report while the
  Workspace is not recovered: whichever failed last, the ready
  (`ready failed: <stage>`) or a connect attempt since the connection last
  came up.
- Publications that arrive while a ready waits are held in
  `HeldPublications`: only the latest start and the latest stop per Agent
  (so a restart survives), and `HELD_NOTICE_CAP` delivery notices, past which
  each Agent keeps only its latest (a notice wakes its Agent; what it reads
  comes from the cloud's read boundary). The server republishes pending
  deliveries while it handles ready, before it answers, so that replay lands
  in this hold too. A dropped notice is never ACKed and stays pending for the
  next accepted ready.
- Every initial ready, reconnect ready, and ready retry obtains a fresh request
  and the current running Agent ID snapshot from the runtime. Never reuse a
  cached one.
- The first ready retries like a reconnect ready (same backoff and
  escalation): `ready` settles only when the cloud accepts it, on `stop`, or
  when its `signal` aborts. Only a reconnect ready reaches `onReconnect`.

## Agent HTTPS refusals

- A 4xx (not 401) whose body is exactly the SDK's `AgentApiRefusal`
  (`{ error, code?, retryable? }`) is an `AgentExplainedRefusalError`, relayed
  to the Agent with its reason and code. Decode that shape; do not add
  another text allowlist (`AGENT_MESSAGE_VALIDATION_MESSAGES` covers only
  bare-text 400 bodies). A 5xx is never a refusal: a send must still be
  reconciled.

## Fire-and-forget messages

Session invalidate (`sendSessionInvalidate`) and Agent context usage
(`sendAgentContextUsage`, Claude Code only) follow the same delivery rules:

- Callers never await them. They go out over `client.rpc(...)` immediately
  when connected.
- While disconnected, buffer only the latest message per Agent and flush the
  buffer on reconnect. Invalidates flush before pending Activity.
- A rejected RPC is logged (`agent_session:invalidate_rejected` for
  invalidates), never thrown or retried. An "unknown RPC method" rejection
  from an older server logs at most once per connection lifetime; other
  rejections log every time.
- The connection never decides whether a context-usage reading changed;
  `daemon-runtime/` does.

## Invalidate launch fencing

- Drop a pending or new invalidate only when its `launchId` differs from the
  latest launch observed by `#observeLaunchIdentity`.
- Learn that launch only from other outbound messages that carry launch
  identity (such as `reportAgentSession`'s `launchId`). Never learn it from
  Activity or from an invalidate itself, and keep it separate from Activity's
  own superseded-launch replay bookkeeping.

## Shutdown notice

- `sendShutdownNotice` is awaited because the connection closes right after
  it. It is bounded by `DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS` (the whole stop must
  fit launchd's 5 s grace), never retried or buffered, skipped when not
  connected, and never throws.
