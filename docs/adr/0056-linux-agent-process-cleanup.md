# ADR 0056: Linux reaps its own Workspace's Agent processes on daemon boot

Status: accepted (2026-09-20; approved by Frank and merged as #506). The double-run boundary changes
here, which is why it needed that approval.
Date: 2026-09-20

## Context

A daemon restart must not leave an Agent process running under the same identity, because the next
dispatch would start a second process on it (the double-run ADR 0033's `exitUnconfirmed` fence
protects against).

Today that is guaranteed on macOS only. macOS runs each Agent as a launchd user job, and the daemon
reaps every job under its Workspace prefix on boot (`packages/daemon/index.ts` `stopLaunchdJobs`;
`src/platform/launchd-job.ts`). Linux has no per-Agent service: an Agent process is a
`Bun.spawn({ detached: true })` process group (`src/platform/process-tree.ts`), and the only thing
that kills leftover ones is the workspace systemd unit's `KillMode=mixed` +
`SendSIGKILL=yes` (`src/supervisor/systemd-workspace-instance.ts`).

`KillMode` only applies when the daemon was started by that unit. A daemon started any other way — a
hand-run `bun run`, a `su`/SSH session without the user bus — leaves its detached Agents running
across a restart. That is the one path on Linux where a restart can double-run an Agent, and it is
the path a developer and any hand-operated Computer actually uses.

## Decision

**On boot, a Linux daemon sweeps its own Workspace's Agent process groups, then starts.**

- Scope is the Workspace, and nothing else. A process is a candidate only when its environment
  carries both `COFORGE_CURRENT_AGENT_ID` and `COFORGE_CURRENT_WORKSPACE_ID` equal to this
  Workspace — the variables the daemon sets on every Agent process
  (`src/code-agent/environment.ts`). The daemon carries neither, so a mis-set variable cannot make it
  a candidate, and another Workspace's Agents (or the same Workspace's other processes) are never
  touched. This mirrors `stopLaunchdJobs`' strict prefix scope.
- The unit of reaping is the **process group** (`/proc/<pid>/stat` field 5), so an Agent's whole
  subtree — its provider client and tool subprocesses — goes with it, not just the parent pid.
- The daemon's own pid and process group are never killed.
- Best-effort and idempotent: a `/proc` entry that disappears between the scan and the kill is
  "already gone"; a sweep failure is logged (`daemon:agent_process_reap_failed`) and startup
  continues. The sweep never blocks the daemon.
- Implementation lives behind a `/proc` seam (`src/platform/linux-agent-processes.ts`,
  `LinuxProcessTable`) so it is testable without real processes, exactly as launchd access is.

`exitUnconfirmed` is **not** removed here. It is the fence that keeps the double-run boundary safe
until this sweep is in place, so the order is: land this cleanup, then the control-record change
(②, owned separately) may drop it.

## Rejected alternatives

- **A per-Agent systemd unit** (the Linux analogue of the launchd job). Rejected: it only works when
  the daemon is systemd-managed, which is exactly the case that fails today, so it does not close the
  gap. It also needs per-launch unit creation/removal and a second service-manager dependency for no
  extra guarantee over the sweep.
- **Rely on the workspace systemd unit's `KillMode`.** Rejected for the same reason: not every daemon
  is started by that unit.
- **A pidfile / `runFullCleanup` per Agent, as the reference Computer does.** Rejected: a pidfile is
  another durable fact with its own staleness, and its absence on a crash is precisely the failure
  mode. The process table is the live truth; we read it directly.

## Consequences

- A Linux daemon started by hand now kills its Workspace's leftover Agents on boot, so a restart can
  no longer double-run an Agent there. macOS behaviour is unchanged.
- Two daemons for one Workspace would kill each other's Agents; that is already impossible in
  practice (`acquireProcessLock`), and macOS has the same property.
- A daemon restart always ends the previous instance's Agent processes, matching macOS. Any future
  daemon handoff that wants to keep Agents alive across a restart must not use this boot path.

## Validation

- Linux: SIGKILL the daemon, restart it, and confirm no Agent process from the previous instance
  survives, and the next dispatch starts exactly one process.
- Linux, daemon not started by systemd (a `su` session with no user bus): same result.
- Linux, two Workspaces on one Computer: a Workspace's boot sweep never kills the other's Agents.
- macOS: `stopLaunchdJobs`' prefix scope is unchanged.
- Unit tests (`test/linux-agent-processes.test.ts`) cover the scope, the group unit, the self
  exclusion, and the already-gone cases.
- Rollback: remove the boot call; the process sweep is a startup step, not a persisted state, so
  removal needs no migration.
