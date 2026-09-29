# supervisor instructions

Rules for the machine Coordinator in `src/supervisor/`. They extend
`packages/daemon/AGENTS.md`.

## Coordinator boundary

- The Coordinator owns no Agent runtime pool. Each Workspace runs as an
  independent OS-managed child instance.
- `machine-supervisor.ts` owns the per-Workspace restart state machine:
  durable stopping/starting progress, completed or cancelled request receipts,
  and explicit stop precedence. It knows OS instance identities, never provider
  sessions.
- Session create/resume selection belongs to the cloud and the Workspace
  runtime, never to the machine registry.
- Neither the Coordinator nor a Workspace runtime scans transcripts to start
  Agents on its own.

## Binding registry

- `binding-store.ts` is the only adapter that validates and atomically
  persists `bindings.json`. Workspace Daemons never write that registry.

## Instance identity and recovery

- `run-supervisor.ts` keeps the application handshake identity separate from
  the OS invocation identity used for crash recovery; do not merge them.
- Recovery adopts an invocation the OS manager already replaced only through
  the same readiness validation as a fresh start.
- An explicit disabled state always wins over automatic restart or recovery.
- A Workspace the cloud refused for good (`workspace_deleted`, `computer_unlinked`)
  is parked in its health journal. Recovery, `start`, and `restart` never start
  it and never clear the park; an unscoped command still starts the other
  bindings and then refuses with the stable reason as `error_code`. Only
  `configure` (setup attaching it again) lifts the park. Parking never deletes
  local config or uninstalls the service.
- `workspace-parking.ts` owns the Workspace process's side: every runtime start
  goes through it, a refusal records the park before the process shuts down
  and exits 0, and its handshake reports where the latest cloud connect stands
  (`connecting`, `connected`, `not_connected` with why). A connection that is
  retrying, before or after it first connected, reports `connecting` with its
  latest failed attempt; an operator answer carries that reason.
- An operator `start`, `restart`, or `stop` has one deadline for the whole
  command (`OPERATOR_COMMAND_BUDGET_MS` in `workspace-start-outcome.ts`, below
  the local lifecycle client's 35 s timeout). It bounds the answer, not the
  work: `MachineSupervisor.command` answers by then even while still queued,
  holding, stopping, or starting, and names those Workspaces `pending`; their
  work finishes in the serialized queue afterwards, so the instance is still
  adopted and a restart's result still recorded. A restart's runner hold keeps
  its full `RUNNER_HOLD_MS`; the deadline never cuts the drain for busy Agents.
  Finished Workspaces are answered with their first cloud connect
  (`awaitCloudConnections`, side by side, each checked at least once); pending
  ones as still connecting. A park refuses the command. Recovery passes no
  deadline.
- A `stop` or `configure` of a Workspace supersedes every start or restart of
  it requested before (systemd's job replacement): the one under way aborts at
  its next step (hold poll, readiness poll, or before stop/start) and one still
  queued never runs; a replaced restart is recorded `cancelled`. Its caller, if
  still waiting, gets the superseded error with the command that starts it again.
- A command that fails after it answered is logged and recorded as the binding's
  `lastFailure` (operation, message, time), which `coforge-computer status`
  shows with the command to retry; the next successful step clears it. A park or
  a supersede is not recorded.
- What an operator reads (`daemon:snapshot`, a command's answer) comes from
  `MachineSupervisor.view()`, which never waits behind a mutation, so neither
  `status` nor a command answer can end in a client timeout. A Workspace whose
  start, restart, or configure is queued or running reads as still connecting;
  an upgrade waits for those before it pauses the Coordinator. The
  Coordinator's own steps keep the serialized `snapshot()`.
- The snapshot reports a parked Workspace's `park_reason`; an upgrade treats it
  as down on purpose, not as an unhealthy runtime set.
- systemd Workspace units restart on failure after cgroup cleanup.
- On macOS, `launchd-workspace-instance.ts` implements the instance seam on top
  of `platform/launchd-job.ts`. Workspace startup reconciles only its own Agent
  job prefix before accepting new work.
- On Windows, `windows-workspace-instance.ts` runs one `__workspace-daemon` OS
  child per Workspace with a durable invocation id. With no OS failure restart,
  the Coordinator's reconcile loop (`windows-workspace-reconcile.ts`) re-runs
  `MachineSupervisor.reconcile` to restart a dead child. Health latching stays
  in the Workspace child's health journal, not in that loop.
