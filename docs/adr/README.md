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
| [0056](0056-linux-agent-process-cleanup.md) | accepted | Linux reaps its own Workspace's Agent processes on daemon boot |
| [0057](0057-message-freshness-hold-contract.md) | proposed | The freshness hold is Raft's send contract, not a server-issued token |
| [0058](0058-opencode-provider.md) | accepted | OpenCode is a per-turn provider whose model variants become the reasoning picker |
| [0059](0059-agent-visibility.md) | accepted | Per-Agent public/private visibility, with per-Agent realtime channels for private Agents |
| [0060](0060-weekly-assistant-per-subject-runtime-session.md) | accepted | WeeklyReportAssistant uses one Agent session per Records subject |
| [0061](0061-channel-agent-attention-routing.md) | accepted | Channel Agent attention routing |
| [0062](0062-photon-wasm-sidecar.md) | accepted | photon_rs_bg.wasm ships as a release sidecar, not embedded in the executable |
| [0063](0063-upgrade-progress-is-computer-state.md) | proposed | Upgrading is a state of the Computer, not of the click that started it |
| [0064](0064-user-preferences-table.md) | accepted | Per-user settings live in a 1:1 `user_preferences` table |
| [0065](0065-in-page-notifications.md) | accepted | In-page notifications while CoForge is open |
