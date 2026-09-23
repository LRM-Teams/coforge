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
- systemd Workspace units restart on failure after cgroup cleanup.
- On macOS, `launchd-workspace-instance.ts` implements the instance seam on top
  of `platform/launchd-job.ts`. Workspace startup reconciles only its own Agent
  job prefix before accepting new work.
- On Windows, `windows-workspace-instance.ts` runs one `__workspace-daemon` OS
  child per Workspace with a durable invocation id. With no OS failure restart,
  the Coordinator's reconcile loop (`windows-workspace-reconcile.ts`) re-runs
  `MachineSupervisor.reconcile` to restart a dead child. Health latching stays
  in the Workspace child's health journal, not in that loop.
