# Upgrade operations and the runner hold

## Upgrade operations and their receipts

Every upgrade or rollback - remote or from the CLI - is one `UpgradeOperation`
`{ requestId, operation, selection, origin, quiet }`, built once at the process
boundary and passed explicitly from there. No environment variable carries an
operation's identity. The operation's durable `<requestId>.request.json` and
`<requestId>.result.json` under `~/.coforge/computer/install/upgrade-results`
are the only channel between the coordinator process and the Daemon, and the
result receipt names its own `request_id`.

The Coordinator records each operation in `~/.coforge/daemon/bindings.json` as
`upgradeOperations`; this is the single canonical operation state for exclusion,
reporting, acknowledgement and audit. The write-once result file is inter-process
evidence that advances it from `pending` to `succeeded`/`failed`, not a second
state machine. Child config and cloud messages are projections of the canonical
record. Settlement happens during exact-request resume and on startup/watch
recovery when needed; server acceptance moves the same record to `acknowledged`.
Only
one operation may be pending per binding; a second request is refused before
anything is launched rather than left to collide over the installation lock.

A terminal result is reported to the server as `computer:upgrade_result`
(`ComputerUpgradeResult`, additive, `protocol_major` unchanged) after the
Workspace daemon's ready handshake. A reported failure settles the request with
reason `reported`; a reported success is corroborating evidence only, and the
server still requires the Computer's own new identity and matching versions
before an upgrade counts as complete. Reported failure text is sanitized of
absolute paths and credential-shaped runs at both ends.

Because the Daemon calls a server method that older deployments do not expose, a
Computer release carrying this behaviour must ship together with the Web
deployment that accepts it.

## The runner hold

Stopping the Supervisor gives each Agent about two seconds (a 1 s SIGTERM / 1 s
SIGKILL ladder), which is not enough for a tool call. Before the stop, the
coordinator therefore sends `daemon:hold` to the Coordinator, which fans it out
to every running Workspace daemon over the per-Workspace sockets it already
owns. A held daemon stops admitting new turns: an inbound delivery is queued on
the existing per-Agent input queue rather than rejected, is never drained and so
is never acknowledged, and no new Agent process is launched. Because the
`agent:deliver:ack` is sent from inside that drain, a held delivery stays
pending on the server and is republished after the restart - nothing is lost.

The coordinator then polls the hold - it is idempotent, so a poll is a repeat
call - until every Agent's last Activity is a terminal detail kind or
`RUNNER_HOLD_MS` (30 s) elapses, then stops regardless, logging one
`upgrade:runner_hold_deadline` event per Agent still busy at the deadline. A
Workspace daemon that does not answer within 5 s counts as idle: an unreachable
daemon must never block an upgrade. The hold is in-memory only, so a restarted
daemon - including one restored by a failed install's rollback - is never born
held.

`upgrade` and `rollback` get the hold because both go through
`UpgradeLifecycle`. `coforge-computer stop` deliberately does not: an explicit
stop is immediate.

`coforge-computer restart` also waits up to 30 s for busy Agents, and a remote
restart from the web is the same `daemon:restart` local RPC, so it waits too. It
does not go through `UpgradeLifecycle`; the Coordinator holds the one Workspace
it is about to stop, immediately before stopping it, and an unscoped restart
holds each enabled Workspace in turn as it reaches it. As with the upgrade, the
wait is bounded and every failure proceeds: a Workspace that cannot be held, does
not answer, or stays busy past the deadline is restarted anyway, logging
`restart:runner_hold_quiescent` or `restart:runner_hold_expired`.

`coforge-computer restart --supervisor` is different again: it restarts the
Coordinator process itself, not a Workspace runtime, through the platform's own
process manager (`launchctl kickstart -k` on macOS; `systemctl --user
reset-failed` then `restart` on Linux; ending and re-running the scheduled task
on Windows), then waits for the local handshake. It is mutually exclusive with
`--workspace`. Before restarting it engages the same fanned-out runner hold
described above, unless the Coordinator cannot be reached at all - the case
this command exists for - in which case it skips the hold and restarts anyway.
It refuses on a `foreground` externally supervised Computer, with the same
wording an upgrade's own restartability check uses. Until this record, the only
way to restart a stuck Coordinator was `systemctl --user restart
coforge-daemon.service` or `launchctl kickstart -k …` by hand, which must never
appear in user-facing copy.
