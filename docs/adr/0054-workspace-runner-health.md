# ADR 0054: Workspace runner health - a self-latching restart budget

Status: accepted
Date: 2026-09-20

## Context

A Workspace child process (`coforge-computer __workspace-daemon`, dispatched
in `packages/computer/src/main.ts`) is supervised directly by the OS, not by
a CoForge process:

- systemd: `Restart=on-failure`, `RestartSec=1s`
  (`packages/daemon/src/supervisor/systemd-workspace-instance.ts`).
- launchd: `KeepAlive{SuccessfulExit:false}` plus `RunAtLoad`, used through
  `restartOnFailure: true`
  (`packages/daemon/src/platform/launchd-job.ts`,
  `packages/daemon/src/supervisor/launchd-workspace-instance.ts`).

Three consequences follow from that, all measured against this repository
before this change:

1. **No exit classification.** `packages/daemon/index.ts`'s `runDaemon` has
   no semantic exit codes; the only deliberate one was `process.exitCode = 2`
   for a missing `--socket`. A permanently broken configuration, a revoked or
   unknown Computer identity, and a genuine crash were all restarted forever
   at the same 1s cadence.
2. **No memory across restarts.** Nothing recorded that a Workspace had
   crashed repeatedly in a short window, so nothing could ever stop the loop
   or tell an operator about it.
3. **`status` could not say why.** `WorkspaceStatus`
   (`packages/computer/src/status/types.ts`) carried only
   `enabled`/`running`/`pid`/`pending`/`unsettledUpgrades`. A Workspace stuck
   in a crash loop and a healthy idle one looked identical.

Comparable commercial code-agent runners solve the same problem at the same
layer - a resident supervisor process watches its own child's exit and
enforces a restart budget. CoForge's Coordinator (`MachineSupervisor`) does
not watch the Workspace child's exit at all: the OS restarts it directly,
so the Coordinator process is not even necessarily running (or reachable)
when a Workspace crashes and gets respawned. That rules out an
externally-enforced budget as this CR's design; the child itself is the
only thing present at every restart.

## Decision

**The Workspace child enforces its own restart budget by exiting 0.**

- `packages/daemon/src/supervisor/workspace-health-journal.ts` adds
  `WorkspaceHealthJournal`: a small durable JSON record
  (`health.json`) next to the Workspace's own state directory - the same
  directory the Coordinator already passes as `--state-directory` when it
  spawns `__workspace-daemon`, and which the Coordinator can therefore also
  reach directly without asking the (possibly absent) child over RPC.
  - `recordStart()` / `recordGracefulStop()` maintain a live marker. There
    is no supervising process watching this child's exit, so the *next* run
    reading `wasLeftRunning() === true` is the only way anything ever learns
    that its predecessor died unexpectedly.
  - `recordCrash(at)` appends one unexpected death, pruned to a 60s window
    (`WORKSPACE_HEALTH_CRASH_WINDOW_MS`), and latches `degraded` the moment
    the pruned count reaches 3 (`WORKSPACE_HEALTH_DEGRADED_THRESHOLD`) -
    frozen at that instant, so the latch does not silently lift later just
    because the triggering crashes aged out of the window.
  - `markTerminal(reason)` latches `degraded` immediately, independent of
    crash count, for a condition no restart can fix (today: a launch missing
    `--socket`).
  - `state()` reports `ok` or `degraded` with the reason, the crash count,
    and when the latch was set.
  - `clear()` is the only way to lift a latch.
- `packages/daemon/src/supervisor/workspace-runner-guard.ts` adds
  `guardWorkspaceRunnerStart(journal)`: the boot-time decision, factored out
  of `runDaemon` so it is unit-testable against a real journal instead of the
  whole process. It checks `state()` first; if already degraded, it reports
  `"exit"` without recording anything more. Otherwise, if the journal was
  left live, it records one crash and re-checks; crossing the threshold also
  reports `"exit"`. Otherwise it records this run live and reports
  `"proceed"`.
- `packages/daemon/index.ts`'s `runDaemon` calls the guard before doing any
  real work (Agent proxy, Workspace connection, local RPC). On `"exit"` it
  logs one error naming the real reason and the exact recovery command
  (`coforge-computer restart --workspace <id>` - the actual form in
  `packages/computer/src/cli.ts`'s `restart` command, not a guessed
  positional argument), then sets `process.exitCode = 0` and returns before
  starting anything. **Exiting 0 is the load-bearing detail**: both
  `Restart=on-failure` (systemd) and `KeepAlive{SuccessfulExit:false}`
  (launchd) restart only on a *non-zero* exit. A Workspace that decides it is
  degraded and exits 0 is, from the OS's point of view, a Workspace that
  shut down on purpose - so neither supervisor ever restarts it again, and
  the loop stops itself with no supervising CoForge process required to be
  watching. The missing-`--socket` precondition (previously
  `process.exitCode = 2`, which *would* trigger a restart loop with a broken
  invocation) now latches terminal and also exits 0, for the same reason -
  **but only when `--state-directory` was also given explicitly.** Under
  every OS-supervised launch (the only shipped path), the Coordinator always
  passes `--socket` and `--state-directory` together
  (`systemd-workspace-instance.ts`'s `workspaceUnit`,
  `launchd-workspace-instance.ts`'s job `command`), so a real deployment can
  never have one without the other; a launch missing `--socket` there is not
  reachable. The only way to hit this branch with `--state-directory` also
  missing is a hand-run invocation of `__workspace-daemon` with no arguments
  at all, which is not a shipped path either - but it is easy to trigger by
  accident. Without the guard, that invocation would fall back to the shared
  default `join(homedir(), ".coforge", "daemon")` and latch *that* path
  degraded; nothing ever calls `clearHealth` against the shared default
  (only per-Workspace directories under it), so a later legitimate run at
  that same default path - the standalone dev harness in this same file, for
  instance - would find itself permanently refused with no way to recover
  short of deleting the file by hand. The fix scopes the write: latch (and
  look up a workspace ID to report) only when `--state-directory` was
  explicit; a launch missing both flags gets today's plain failure, exactly
  as before this change, and never touches the shared default's journal.
  Graceful `SIGTERM`/`SIGINT` shutdown (`shutdown()` inside `runDaemon`)
  calls `recordGracefulStop()`, so an operator stop, a restart, and an
  upgrade (`machine-supervisor.ts`'s own `#stop`, used by
  `holdRunnersUntilQuiescent`-gated restarts) are never miscounted as
  crashes.
- `packages/daemon/src/supervisor/machine-supervisor.ts`'s
  `MachineSupervisor.command("start" | "stop" | "restart", ...)` gained an
  optional `WorkspaceProcesses.clearHealth(binding)` call, invoked only for
  the `"start"` and `"restart"` branches - never for `"stop"`, and never from
  automatic recovery on Coordinator startup (`#reconcileBindings`, driven by
  `recover()`). This is deliberately the *only* seam that clears a latch: an
  explicit operator action clears it, while an OS-level crash-loop respawn -
  which never reaches `command()` at all - cannot. `run-supervisor.ts`
  implements `clearHealth` by calling `WorkspaceHealthJournal.clear()`
  against the same per-Workspace directory the Coordinator already derives
  (`workspaceStateDirectory`, extracted from `run-supervisor.ts`'s former
  private closure into `workspace-instance.ts` so both the Coordinator and
  Computer's `status` compute the identical path). **A server-requested
  restart also clears the latch, by design.** `packages/daemon/index.ts`'s
  `requestRestart` closure (wired to the Workspace daemon's cloud connection)
  reaches the Coordinator through the exact same `supervisorControl("restart",
  ...)` -> `command("restart", ...)` path an operator-issued
  `coforge-computer restart --workspace <id>` uses; there is no separate
  server-restart code path to exempt. This is intended - a server-requested
  restart still means a human asked for it (through the Workspace page) - but
  it means the latch does not distinguish "restarted from the CLI" from
  "restarted from the server"; both count as the operator action that earns a
  fresh budget.
- The Coordinator itself, not only the child, now consults the journal:
  `run-supervisor.ts`'s `WorkspaceProcesses.start(binding)` reads
  `WorkspaceHealthJournal.state()` before touching the OS unit at all, and
  refuses immediately (logging the reason, crash count, and recovery command
  as a structured `workspace:degraded_start_refused` event) when degraded.
  Without this, `MachineSupervisor.#reconcileBindings` - which every Coordinator
  boot runs before its own local RPC server even starts listening - would call
  `#start` on a degraded binding, which would spawn the OS unit, watch the
  replacement child observe the same latch and self-exit 0 within its own
  guard check, and then spend the full 30s local-RPC readiness budget
  discovering that no socket ever opened, throwing only a generic "Workspace
  \<id> failed process readiness". Measured before this fix (real launchd,
  compiled binary, `packages/daemon/test/macos-supervisor.test.ts`'s harness):
  a single degraded binding delayed the Coordinator's own local RPC from
  opening for ~37s, and Computer's own client-side handshake (a separate,
  shorter timeout) gave up after 10s with "CoForge Daemon did not accept the
  local handshake... " - never surfacing the real reason at all. With the
  fast-fail check, the same scenario recovers and reports in well under a
  second.
- `packages/computer/src/status/types.ts` adds a `WorkspaceHealth` field to
  `WorkspaceStatus` and a new pure-read `StatusPorts.readWorkspaceHealth`
  port. `create-status-ports.ts` implements it by reading the same
  `health.json` directly (mirroring how `loadBindings` already reads
  `bindings.json` directly rather than through the Coordinator's RPC) - a
  missing or corrupt file reads as `ok`, since a lost health record must
  never itself make a Workspace look broken. `render-status.ts` prints a
  `degraded:` line with the reason, crash count, and since-timestamp, plus a
  `recover:` line with the exact command, only when a Workspace is actually
  degraded; a healthy Workspace's output is unchanged.

## Rejected alternatives

- **A supervising CoForge process (Coordinator) watches the child's exit and
  enforces the budget itself**, the way a resident-service architecture
  would. Rejected: the Coordinator is not guaranteed to be running or
  reachable at every Workspace restart (it has its own independent
  lifecycle), and introducing that dependency would mean a Workspace's
  crash-loop protection silently stops working whenever the Coordinator is
  down - exactly the condition under which protection matters most. The
  child is the only participant guaranteed to be present at its own restart.
- **Change the OS unit's restart policy** (e.g. add `StartLimitBurst`/
  `StartLimitIntervalSec` to the systemd unit, or a launchd throttle) instead
  of an application-level latch. Rejected for this CR: out of scope per the
  brief, and it would not produce a reason or a `status` explanation -
  systemd would just stop trying, silently, with no durable record for
  `coforge-computer status` to read. The exit-0 latch is strictly more
  informative and works identically on both platforms without unit changes.
- **A local IPC/RPC call from the child to the Coordinator to report
  crashes**, instead of a shared file. Rejected: it requires the Coordinator
  to be up, which is exactly the dependency the first rejected alternative
  also failed on; a same-directory durable file needs nothing else running.

## Consequences

- A Workspace that fails 3 times inside 60 seconds, or hits a precondition
  no restart can fix, now stops trying and reports why through
  `coforge-computer status`, instead of spinning forever at the OS's
  restart cadence.
- `coforge-computer restart --workspace <id>` is now also the recovery
  action after a degraded latch, not only an ordinary restart; no new
  command was added.
- A Workspace's `health.json` is best-effort, non-authoritative
  observability state: losing or corrupting it degrades only that one
  section of `status` (reads as `ok`), never the rest of the report, and
  never blocks a start.
- Left out of this CR, flagged as follow-up in the PR body: whether
  `packages/daemon/index.ts`'s `daemon:workspace_recovery_failed` branch (a
  Workspace whose cloud recovery fails inside `daemon.start()`, which today
  only logs and leaves the process alive with local RPC listening) should
  also feed this journal. Classifying *why* that recovery failed (transient
  network vs. a genuinely broken Workspace) is the same error-classification
  problem the ADR 0049-series Agent-runtime CR is already scoped to solve;
  folding it in here would have widened this CR's scope beyond the exit-code
  latch it is about.

## Validation and rollback criteria

- `packages/daemon/test/workspace-health-journal.test.ts`: the crash-window
  threshold and pruning, the terminal latch, the live/graceful-stop marker,
  and `clear()`.
- `packages/daemon/test/workspace-runner-guard.test.ts`: the boot-time
  decision (fresh start, graceful predecessor, crash-that-crosses-threshold,
  already-degraded) against a real journal.
- `packages/daemon/test/machine-supervisor.test.ts`: `clearHealth` is called
  for explicit `start`/`restart`, never for `stop`, and never from automatic
  recovery on Coordinator startup.
- `packages/computer/test/status-collect.test.ts` and
  `status-render.test.ts`: a degraded Workspace's health is surfaced with
  its reason/crash count/since, a healthy Workspace's rendered output is
  unchanged, and a missing health journal reads as `ok`.
- `packages/daemon/test/macos-supervisor.test.ts` (real launchd, a compiled
  fixture binary, darwin only): "a degraded Workspace fails fast on
  Coordinator recovery instead of stalling the readiness budget" - marks a
  running Workspace's journal degraded, kills the live child so launchd
  respawns it under the (still unfixed-without-this-CR) latch, kills and
  restarts the Coordinator, and asserts the Coordinator's local RPC becomes
  reachable again in well under the old ~30-37s stall, that the binding
  reports `processId: 0`, and that an explicit `restart` still clears the
  latch and brings it back. This is the test that produced the measured
  numbers cited above.
- Rollback criterion: reverting this change returns the Workspace child to
  its previous unconditional-restart behaviour (safe, if unobservable) and
  drops the `health` field from `status`; no schema or wire-protocol change
  is involved, so rollback is a plain revert.
