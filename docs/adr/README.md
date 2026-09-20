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
| [0046](0046-member-read-cursor-channel-unread.md) | accepted | Per-member read cursor and the channel unread badge |
| [0047](0047-kiro-turn-errors-carry-their-reason.md) | accepted | Kiro turn errors carry their real reason, scrubbed; one Activity per failed turn |
| [0048](0048-daemon-delivery-queue.md) | accepted | Daemon-owned delivery queue with busy gating |
| [0049](0049-rollback-unit-is-the-release.md) | accepted | The rollback unit is the release, not the image |
| [0050](0050-agent-context-usage-display.md) | accepted | Agent context-window usage display (Claude Code only) |
| [0051](0051-agent-context-breakdown.md) | accepted | Agent context-window composition breakdown (Claude Code only) |
| [0052](0052-message-sender-identity.md) | accepted | A message's sender is a kind, a handle and a description |
| [0053](0053-daemon-connection-inbound-liveness.md) | accepted | An open socket is not evidence that the Daemon is reachable |
| [0054](0054-workspace-runner-health.md) | accepted | A crash-looping Workspace latches itself degraded and says so |
| [0055](0055-agent-runtime-failure-recovery.md) | accepted | Classify runtime failures, back off deliveries, and fence a repeating one |
| [0056](0056-linux-agent-process-cleanup.md) | proposed | Linux reaps its own Workspace's Agent processes on daemon boot |
