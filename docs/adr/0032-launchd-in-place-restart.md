# ADR 0032: A Computer upgrade restarts the launchd user agent in place

Status: accepted
Date: 2026-09-17

## Context

A Computer upgrade dev.34 → dev.35 failed twice on 2026-09-17 with "CoForge Daemon did
not accept the local handshake" and rolled back both times. The launchd unified log
for the failing attempt reads:

```
14:25:50.545 bootout initiated by launchctl<-coforge-computer   (upgrade's lifecycle.stop -> LaunchdDaemonHost.stop)
14:25:50.546 scheduling cleanup in 5 sec after sending Terminated: 15
14:25:55.541 service inactive / removing service: cn.coforge.computer.daemon   (old daemon hung on shutdown, SIGKILLed at 5.0 s)
             ... dev.35 was never spawned ...
14:25:59.967 Could not find job with label ...   (rollback: print fails -> bootstrap)
14:26:01.106 Successfully spawned                (dev.34 back)
```

`launchctl bootout` returns as soon as it has *asked* launchd to tear the job
down, not once launchd has finished doing so. `LaunchdDaemonHost.ensureInstalled()`
(`packages/daemon/src/daemon-host/launchd.ts`) then did `launchctl print <target>`;
exit 0 meant "already installed", so it returned without bootstrapping. During the
5-second teardown window `print` still answered 0 — the old instance was still
"loaded" from launchd's point of view, only exiting slowly — so the previous
upgrade code skipped the bootstrap entirely. launchd finished removing the job a
moment later, with nothing left to start the new daemon, and
`LocalDaemonLauncher.#waitForHandshake` timed out ten seconds after a daemon that
was never spawned.

The plist's `ProgramArguments` point at the `install/active/coforge-computer`
symlink, which is identical across versions, so the launchd job itself never
needs to change for an ordinary upgrade — only the file the symlink resolves to
does.

### Measured `kickstart -k` behaviour

`launchctl kickstart -k` was measured on macOS 27 against a throwaway launchd
job (`cn.coforge.scratch.*`, removed afterwards):

- It sends SIGTERM first; a process that traps it and exits cleanly is not
  SIGKILLed. A process that ignores it is SIGKILLed after 5 s.
- It is synchronous: it returns only once the *new* process has been spawned
  (confirmed with `-p`, which prints the new pid). Measured 2.35 s when the old
  process took about 2 s to clean up, and 5.02 s when it ignored SIGTERM and had
  to be killed.
- It re-resolves `ProgramArguments` at spawn time, so a symlink switched
  *before* the kickstart is honoured immediately - no separate reload step.
- If the old instance had been running under 10 s, launchd's respawn throttle
  applies and the call blocks for roughly 9 s until it allows the new spawn.

The consequence that matters: there is no window in which the label is
unloaded. `bootout` creates exactly that window; `kickstart -k` never does.

## Decision

**`launchctl kickstart -k` replaces `bootout` + `bootstrap` as the primary path
for a Computer upgrade on launchd**, following the pattern reported in
[openclaw/openclaw#41815](https://github.com/openclaw/openclaw/issues/41815).

`LaunchdDaemonHost` (`packages/daemon/src/daemon-host/launchd.ts`) gains:

- **`restart()`** - the in-place replacement an upgrade uses instead of
  `stop()` + `start()`. If the label is loaded, it runs `launchctl kickstart -k
  <target>` with a generous 30 s timeout (the measured worst case, ~9 s from the
  respawn throttle, needs headroom, and this call must never be treated as
  hung). If the label is *not* loaded - the recovery branch, not the common
  case - it falls back to the same write-plist-then-`bootstrap` `ensureInstalled`
  already used, retrying only on the exit codes documented as "a previous
  bootout for this label is still tearing down" (5 = EIO; 37 = operation already
  in progress - see
  [rossoctl/cortex#880](https://github.com/rossoctl/cortex/pull/880) and
  [Layr-Labs/d-inference#1102](https://github.com/Layr-Labs/d-inference/issues/1102)),
  up to 3 attempts, 1 s apart, then failing with the launchctl diagnostic.
- **`assertRestartable()`** - throws unless the label is currently loaded.
  Lets an upgrade refuse a `foreground`, externally supervised Computer (which
  never installed this user agent) *before* it switches the active executable
  symlink, rather than discovering it only after `restart()` finds nothing to
  kickstart.
- **`restartsInPlace = true`** - a readonly capability flag, so a caller can
  branch on "this host restarts in place" without an `instanceof` check or a
  `process.platform` test. `SystemdUserDaemonHost` and `WindowsUserDaemonHost`
  do not gain kickstart semantics and do not declare this flag; they keep
  stop → activate → start, because neither systemd nor Scheduled Tasks were
  implicated in this incident and neither has been measured the way launchd
  was here.

`LaunchdDaemonHost.stop()` (used by `coforge-computer stop`, unrelated to the
upgrade path above) is also fixed: after a successful `bootout` it now polls a
fresh `launchctl print <target>` every 50 ms, bounded at 15 s (longer than
launchd's 5 s SIGKILL window), and only returns once the label has actually
left launchd. Previously it returned as soon as `bootout` returned, which is
exactly the bug described above, just reached from the explicit-stop path
instead of the upgrade path. A label already absent (`bootout` exit 3, Darwin
ESRCH) still returns immediately - no waiting is owed on a fresh machine.

Every `LaunchdDaemonHost` command failure now carries launchctl's stderr
diagnostic (`launchctl <op> failed (<code>): <diagnostic>`), reusing
`nativeCommandDiagnostic` from `packages/daemon/src/platform/launchd-job.ts`
the same way PR #208 did for `LaunchdJob`. The injectable `CommandRunner` seam
returns `{ code, stdout, stderr }` instead of a bare exit code so the
diagnostic survives the injection boundary in tests too.

**`UpgradeLifecycle` (`packages/computer/src/release/upgrade-lifecycle.ts`)
gains a readonly `restartsInPlace: boolean`.** For a launchd host,
`createSupervisorUpgradeLifecycle` wires:

- `stop(snapshot)` to `host.assertRestartable()` - the pre-switch check, not
  an actual stop - mapped to the same "Cannot upgrade a foreground externally
  supervised Computer..." error `stop()`'s old failure path already threw,
  under the same `upgrade:coordinator_stop_*` log events, with wording that no
  longer claims to be stopping anything.
- `start(snapshot, version)` to `host.restart()` - the actual kickstart -
  under the same `upgrade:coordinator_start_*` events.

`performSwitch` (`upgrade-coordinator.ts`) is therefore, for a launchd host,
really check → activate → kickstart → probe, while staying stop → activate →
start → probe in shape and in call sites for every other host. `probe`
verifies a new `daemonId`, the expected version, and new runtime pids exactly
as it did before; kickstart's guarantee that the old process is gone before
the new one starts makes that check sufficient without also re-running the
non-in-place path's 35 s `supervisor.lock/owner` wait, which exists to confirm
an old process *tree's* shutdown - not needed here, because there is no
"old process still shutting down while a new one starts" window to confirm
against.

**The rollback re-entry is tolerant of a missing label.** `performSwitch` is
called a second time, unchanged, when the candidate fails; that means
`lifecycle.stop()` (the restartability check) runs twice per failed upgrade.
The first call, before the candidate is even activated, must refuse a
foreground-supervised Computer outright. The second call, during the restore,
must not: by the time a restore runs, either the label is still loaded (the
common case - a kickstart that failed, or a candidate that came up unhealthy,
does not unload the job) and the check passes trivially, or it is genuinely
gone (a bootstrap fallback that itself failed earlier in the same upgrade) and
`restart()`'s own bootstrap branch is exactly what recovers it. Failing the
rollback here would be strictly worse than letting `restart()` try.
`createSupervisorUpgradeLifecycle` tracks this with one boolean, set the first
time `assertRestartable()` succeeds: a *later* failure of the same check is
treated as "let `restart()` recreate it" rather than re-raised as "foreground
supervisor." A `stop()` call that has never once seen the label loaded still
refuses outright, so a genuinely foreground-supervised Computer fails the same
way on the candidate switch and on its rollback.

**Stage text stays truthful.** `switchStageText` no longer prints "Stopping
Computer supervisor..." before an in-place switch, because `stop()` does not
stop anything there. The sequence for a running, in-place host is:
`Switching the active executable to X`, then `Restarting Computer supervisor
as X (N running Workspace runtime(s), M stopped Workspace binding(s) left as
is)`. The non-in-place wording, and the `supervisorRunning: false` wording for
both kinds of host, are unchanged byte-for-byte.

**The runner hold still precedes the restart.** ADR 0020's hold runs once,
before `performSwitch` is even called, regardless of which lifecycle is in
play. For a stop-then-start host the ~2 s SIGTERM/SIGKILL ladder it exists to
keep away from a live tool call runs inside `stop()`; for an in-place host
that same ladder runs inside `start()`'s kickstart instead. Only where it runs
moved - the hold still has to be in place first either way, and it is.

## Rejected alternative: keep `bootout` → wait → `bootstrap` as the primary path

This was the direct fix on the table: make `stop()` wait for departure (which
this record also does, for the unrelated `coforge-computer stop` path) and
retry `bootstrap` if it lands mid-teardown. It was rejected as the *upgrade's*
primary path because it still opens an unload window on every single upgrade -
it only closes the window faster and adds a retry to paper over the residue.
`kickstart -k` has no unload window at all, so there is nothing to compensate
for. The wait-and-retry shape is kept, deliberately, as `restart()`'s
*recovery* branch for the one case kickstart cannot handle: the label already
being gone.

## Consequences

- **A plist change cannot ride a kickstart.** `kickstart -k` restarts the
  *currently loaded* job definition; it does not reload `ProgramArguments`,
  environment variables, or any other plist key from disk if the plist file
  itself changed (as opposed to what the existing `ProgramArguments` symlink
  points at, which it does re-resolve). A future release that needs to change
  the plist - a new environment variable, a different `KeepAlive` policy -
  cannot ship through this path unchanged; it needs a `bootout` → wait →
  `bootstrap` migration step for that one release, with the same departure
  poll `stop()` now performs. This is a real limitation of the general
  approach, not a defect in this change: it is exactly why the wait-and-retry
  shape above is being kept alive as a fallback rather than deleted.
- `coforge-computer stop` now takes up to 15 s longer in the pathological case
  where the old job refuses to leave launchd (previously: none, because it
  didn't wait at all and would report success while the job was still
  present). In the ordinary case it is unchanged, because the label is usually
  gone within milliseconds of a clean shutdown.
- Every `LaunchdDaemonHost` failure message changes shape (now
  `launchctl <op> failed (<code>): <diagnostic>`); any code or test matching
  the old bare messages (e.g. "could not stop the CoForge Daemon") needed
  updating. None of that text is parsed by the daemon or server, only surfaced
  to an operator or a CLI caller.
- Not comparable to Raft Computer 1.0.32: its launchd job is a `RunAtLoad`-only
  login carrier with no `KeepAlive`, and its upgrader (`k-carrier`) never
  restarts anything through launchd at all. There is no prior art here to
  compare against, unlike ADR 0020/0021's runner hold.

## Why the old daemon took 5 s to exit

The teardown window was 5 s wide because the dev.34 Coordinator logged
"Coordinator process stopped" and then stayed alive until launchd SIGKILLed it.
`holdWorkspaceRunners` (`packages/daemon/src/supervisor/run-supervisor.ts`)
bounded each Workspace's hold answer with
`Promise.race([hold, Bun.sleep(5_000).then(throw)])`. The losing sleep of a
settled race is still pending, and a pending `Bun.sleep` keeps the event loop -
and so the process - alive (measured: a script whose race settles in 3 ms exits
after 5.01 s). An upgrade's last hold poll lands just before the stop, so the
Coordinator outlived its shutdown by 5 s, which is exactly launchd's SIGKILL
window. The runner hold shipped in dev.31 (ADR 0020); the dev.30 → dev.34 upgrade
the day before was stopped by a dev.30 daemon and exited in 0.45 s.

This change replaces the race with `answeredWithin` (`runner-hold.ts`), which
always clears its timer. The same `Promise.race` + `Bun.sleep` shape remains in
`code-agent/runtime-inventory.ts` and `platform/launchd-process.ts`; those run in
Workspace daemons whose launchd jobs already carry `ExitTimeOut` 2, were not
part of this incident, and are left alone here.

## Machines already on dev.31 - dev.35 need one manual bridge (macOS only)

`launchUpgradeCoordinator` starts the coordinator from `process.execPath`, the
*installed* version. An upgrade *to* the release carrying this change is
therefore still driven by the old `bootout` → `print` → skip-bootstrap logic
and still fails (safely: it rolls back) whenever a Workspace runtime is
running, because only then does the hold run and the old daemon linger. With no
running runtime nothing lingers and the old logic works, so the bridge is:

```sh
coforge-computer stop      # disables every binding; no runtime left to hold
coforge-computer upgrade
coforge-computer start     # re-enables every binding, including ones stopped on purpose before
```

Linux is unaffected: `systemctl --user stop` returns only once the unit has
stopped, and `SystemdUserDaemonHost.ensureRunning()` always issues `start`
rather than inferring "already installed" from a query. The lingering sleep
only made its stop 5 s slower. Windows (`schtasks /End`, no wait) has not been
examined on a real machine.

Two follow-ups are deliberately not part of this change:

- openclaw restarts its systemd unit the same way it restarts its launchd job:
  one `systemctl --user restart`, preceded by `systemctl reset-failed`
  (`src/daemon/systemd-lifecycle.ts`, `src/cli/update-cli/restart-helper.ts`).
  `restartsInPlace` makes adopting that a small change. Whether our
  `Restart=on-failure` unit can hit systemd's start limit with a crash-looping
  candidate, and so refuse the rollback's `start`, is unverified.
- Running the coordinator from the *new* version's executable would let a fix to
  upgrade logic apply to the upgrade that delivers it, at the cost of trusting
  the candidate with its own rollback. That changes ADR 0020's trust model and
  needs its own decision.

## Validation and rollback

Unit tests over `LaunchdDaemonHost` (`packages/computer/test/daemon-host-launchd.test.ts`):
a regression reproducing the incident (the label answers `print` = 0 for
several polls after `bootout` before `stop()` may return); `restart()` on a
loaded label issuing exactly `kickstart -k` and never `bootout`/`bootstrap`;
`restart()` on an absent label bootstrapping with retries limited to exit
codes 5 and 37 and a diagnostic-bearing failure after 3 attempts; a
non-retryable bootstrap code failing on the first attempt; `assertRestartable`
resolving/throwing on loaded/not-loaded; `stop()` returning immediately on an
already-absent label and timing out with a clear error when the label never
leaves; and a failed command's stderr diagnostic surviving into the thrown
error. Unit tests over `upgrade-coordinator.ts`
(`packages/computer/test/upgrade-coordinator.test.ts`) cover the in-place call
order (check → activate → restart → probe) and stage text against a fake
`restartsInPlace: true` lifecycle, and the rollback order (check → restore →
restart → probe) when the candidate's in-place restart fails. The lifecycle's
own tolerance of a label that is gone on the rollback's re-check has no unit
test: `createSupervisorUpgradeLifecycle` builds its host and socket client
internally. `answeredWithin` is covered by a test that spawns a real process and
measures its exit, and fails (5 s) with the `Bun.sleep` form restored.

`LaunchdDaemonHost` was also run against real launchd with a scratch label
whose process ignores SIGTERM, reproducing the incident's shape: `restart()`
returned after 5.02 s with the newly linked executable running and the label
loaded throughout; `stop()` returned after 5.04 s with the label gone; `stop()`
on the absent label returned in 0.01 s. The existing non-in-place ordering, stage text, and rollback tests
are unchanged in meaning; a `restartsInPlace: false` field was added to their
fake lifecycles only because the interface grew that field.

Not verified: no live upgrade was run against the real `cn.coforge.computer.daemon`
job on this machine (a live daemon is running here and was deliberately left
untouched), so the end-to-end claim that a real dev.34 → dev.35 switch now
succeeds rests on the unit-level seams and the standalone `kickstart -k`
measurements above, not on an observed upgrade.

Rollback is by revert. `stop()`'s departure poll and the stderr diagnostics are
strictly additive and safe to keep even if `restart()`/`assertRestartable()`
are reverted; a revert of the lifecycle wiring alone returns a launchd host to
the previous stop-then-start upgrade path, which is correct but reintroduces
the unload-window bug this record fixes.
