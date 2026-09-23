# connection instructions

Rules for the Workspace cloud connection in `src/connection/`. They extend
`packages/daemon/AGENTS.md`.

## Boundary

- This directory owns the daemon's long-lived WSS connection, ordered replay,
  reconnect, and protocol transport mechanics. Domain decisions stay in
  `daemon-runtime/` and below.
- `built-server.ts` supplies the build-inlined server and WSS endpoint. Do not
  read them from anywhere else.
- Every initial ready, reconnect ready, and ready retry obtains a fresh request
  and the current running Agent ID snapshot from the runtime. Never reuse a
  cached one.

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
