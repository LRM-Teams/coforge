# persistence instructions

Rules for durable local state in `src/persistence/`. They extend
`packages/daemon/AGENTS.md`.

- `daemon-config.ts` owns environment validation for daemon configuration and
  recovery. The entrypoint uses it; it does not validate environment itself.
- This directory owns atomic record writes, atomic App Inbox storage, and
  guarded Agent workspace clearing.
- Persisted Agent runtime records stay outside the Agent workspace, so clearing
  a workspace can never delete them.
- A connection outbox is not durable storage, and nothing here is a jobs queue
  or a Message outbox.
