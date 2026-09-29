# agent-reminder instructions

Rules for `src/agent-reminder/`. They extend `packages/daemon/AGENTS.md`.

- The cloud schedule is authoritative. This directory mirrors it with
  version-fenced timers, bounded durable fire receipts, and exact-revision
  acknowledgement.
- Never persist the schedule mirror itself; only fire receipts are durable.
- Never wake an Agent for a reminder before the cloud accepts the fire.
- `stop()` is synchronous: it cancels timers and fences out every later result.
  Work it cannot cancel (a fire request, a receipt write) keeps running, and the
  runtime's `stop` awaits `awaitIdle()` under a bound. Every path that arms a
  timer checks `#running` first, including one reached after an `await`.
