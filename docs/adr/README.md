# Architecture decision records

Use this directory for decisions that change an accepted invariant in [`../architecture.md`](../architecture.md).

Name records `NNNN-short-title.md` and include:

- status and date;
- context and constraints;
- chosen decision;
- rejected alternatives;
- consequences and migration plan;
- validation and rollback criteria.

Do not use an ADR to silently rewrite history. Supersede the old record and link both directions.

## Index (selected)

| ADR | Status | Topic |
| --- | --- | --- |
| [0032](0032-weekly-report-collectors-and-collect-run.md) | accepted | Weekly-report per-Computer collectors + narrow Collect Run |
| [0048](0048-daemon-delivery-queue.md) | accepted | Daemon-owned delivery queue with busy gating |
| [0047](0047-kiro-turn-errors-carry-their-reason.md) | accepted | Kiro turn errors carry their real reason, scrubbed; one Activity per failed turn |
| [0046](0046-member-read-cursor-channel-unread.md) | proposed | Per-member read cursor and the channel unread badge |
