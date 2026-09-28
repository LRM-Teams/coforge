# agent-reminder instructions

Rules for `src/agent-reminder/`. They extend `packages/daemon/AGENTS.md`.

- The cloud schedule is authoritative. This directory mirrors it with
  version-fenced timers, bounded durable fire receipts, and exact-revision
  acknowledgement.
- Never persist the schedule mirror itself; only fire receipts are durable.
- Never wake an Agent for a reminder before the cloud accepts the fire.
