# Reminders

These rules apply to `src/server/reminders/`.

- The public `Reminders` interface owns authorization, recurrence, fire
  idempotence, and snapshot behavior. Its repository owns PostgreSQL locking
  and persistence only.
- The authenticated Agent HTTPS and Daemon WSS compositions are adapters
  only; they never re-implement Reminder rules.
- Daemon capability leases remain volatile, and reminder timer state remains
  owned by the Daemon.
- The owner-only browser read model in `server/agents/agent-reminders.server.ts`
  reads bounded, scheduled Reminders only; lifecycle and history persistence
  stay here.
