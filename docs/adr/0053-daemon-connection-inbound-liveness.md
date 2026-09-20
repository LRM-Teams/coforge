# ADR 0053: An open socket is not evidence that the Daemon is reachable

Status: accepted
Date: 2026-09-20

## Context

On 2026-09-20 an Agent on a staging Computer stopped replying while
everything that reports health said it was fine. `coforge-computer status`
showed the supervisor loaded, its local RPC reachable, and the Workspace
runtime running. The Agent's own runtime process was alive and had
successfully resumed its thread. Nothing was down.

What the Workspace Daemon log showed was this, repeating:

```json
{"level":"WARN","event":"daemon_control:rejected",
 "workspace_id":"3ae9a970-…","computer_id":"1147ea1c-…",
 "payload_bytes":300,"error_message":"premature EOF","outcome":"rejected"}
```

Every control frame the server published was dropped at the protocol
boundary, so the attention that should have woken the Agent never reached the
runtime. The socket stayed open. The subscription stayed live. The Daemon
never noticed, never reconnected, and reported itself online the whole time.
A person had to run `coforge-computer restart`, after which the same Computer
worked immediately. Restarting through the upgrade path earlier the same
afternoon had *not* cleared it.

That is the shape of the defect: **CoForge treated "the transport says it is
connected" as proof that the Daemon is reachable.** `DaemonConnection` had no
notion of inbound traffic at all - no record of when anything last arrived,
no probe, no timeout, no forced rebuild. Recovery depended entirely on
`centrifuge-js` deciding to reconnect, and it does not reconnect for every
way a connection can stop being useful. A connection that carries nothing was
indistinguishable from a Workspace with nothing to say.

The connection already sends a Computer status RPC every 30 seconds
(`COMPUTER_STATUS_REFRESH_MS`). Its result was discarded with
`.catch(() => {})`. A round trip that already runs, and that already proves
the link works in both directions, was being thrown away.

## Decision

The Daemon's cloud connection tracks when it last carried inbound traffic,
and rebuilds itself when it has carried none for long enough.

- **Inbound traffic** means a publication on the Daemon's own channel, or an
  answered Computer status RPC. It is recorded *before* decoding, so a frame
  no decoder accepts still counts: such a frame proves the link is carrying
  data, and the failure it represents belongs to the protocol boundary, not
  to liveness.
- A Workspace with nothing to say still produces the 30-second status round
  trip, so a quiet Workspace is never mistaken for a dead connection. This is
  why the existing RPC is the probe rather than a new one.
- At 70 seconds with nothing inbound the connection is reported quiet
  (`daemon_connection:inbound_quiet`), once per quiet stretch.
- At 140 seconds - four consecutive unanswered status round trips - the connection is
  rebuilt: `daemon_connection:inbound_stalled`, then `disconnect()` followed
  by `connect()` on the same client, which re-runs the existing reconnect
  path (ready recovery, Activity and status flush).

The policy itself is a pure function, `connectionLiveness(lastInboundAgeMs)`,
so the thresholds are testable without timers.

## Consequences

- A Computer that has silently stopped receiving recovers on its own within
  about two and a half minutes. The manual `coforge-computer restart` that
  this incident required is no longer the only recovery.
- The two thresholds are deliberately generous relative to the 30-second
  status interval. A single missed round trip, or two, changes nothing; only
  a sustained absence of traffic rebuilds the connection. A Computer on a
  poor link reconnects at most once per 140-second window.
- `daemon_connection:inbound_quiet` and `daemon_connection:inbound_stalled`
  are new operational signals. A Computer that repeats the stalled event is
  reporting a real transport problem, not noise.
- This does not change the architecture invariant that one Daemon owns
  exactly one long-lived WSS connection for its Workspace, and it adds no new
  endpoint, message, or wire field.
- It does not explain *why* the frames became undecodable. That cause is
  still open; PR #474 makes the next occurrence diagnosable by recording
  every decoder's own reason and the payload's field shape. This ADR is about
  recovering without a person, whatever the cause turns out to be.
