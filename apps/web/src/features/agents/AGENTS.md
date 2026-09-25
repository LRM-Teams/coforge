# Agents UI

These rules apply to `src/features/agents/`.

## Agent state in the browser

- `WorkspaceAgentsProvider` (`workspace-agents-realtime.tsx`) is the app
  shell's one Agent status subscription and one Activity subscription.
  Avatars, pages, and panels read through its hooks (`useLiveAgents`,
  `useLiveAgent`, `useAgentRecentActivity`, `useAgentActivityFeed`,
  `usePrefetchAgentActivityFeed`) and never
  open connections or subscribe themselves. The conversations feature does not
  own Agent state.
- `agent-status-realtime.ts` consumes backend display snapshots from the
  initial server response and the realtime status channel and accepts newer
  revisions. At display expiry it refreshes from the backend and retries on
  failure. It implements no reducer. It keeps the last snapshot when a refresh
  fails; an unavailable initial snapshot with no prior value is unknown, not
  offline.
- Activity lives in the TanStack Query cache (`agent-activity-queries.ts`).
  Publications patch it with `setQueryData`; every (re)subscribe invalidates
  it; it refetches when the tab becomes visible or the network returns.
  History and live entries deduplicate by launch ID and client sequence.
  Timeline history never changes the display snapshot.
- The client Activity window and the server's `AgentActivityRepository.HISTORY_LIMIT`
  are the one shared constant (`activity-history-limit.ts`); changing the number
  changes both.

## Activity display

- UI renders the cloud-authored unified Agent display. It never reduces raw
  facts, interprets provider message text, or owns transport. Current state and
  expiry decisions belong to the cloud reducer.
- Render `agent:activity` fields `detail`, `detailKind`, `entries`,
  `observedAtMs`, and the CoForge `level` extension in the Agent-owned timeline
  in this directory.
- Activity content and labels are **not internationalized**. Use plain English
  activity labels consistently in the timeline, avatar hover, and chat header.
  Do not add Activity label translation keys. Navigation, tabs, and general UI
  remain localized.
- Preserve provider text, thinking, errors, and warnings in their original
  language and wording, subject to required secret redaction.
- Display backend status detail. Tool labels come from structured tool names,
  never commands or paths. Working and thinking use the yellow work treatment.
- Render unknown detail kinds with a generic activity presentation and the
  original detail instead of dropping the record.
- Show command and workspace-relative file path messages as copyable
  monospace text. Never expect or render file contents, diffs, prompts,
  secrets, or raw provider stderr in an activity record.
- The user-approved display-content exception is structured `entries`
  containing provider-exposed assistant text and thinking intended for
  display. Never extract hidden reasoning or copy raw tool arguments, outputs,
  or patches. Render that text as plain text, not HTML; redaction is best
  effort, not a guarantee that every sensitive statement can be recognized.
- Merge consecutive text (or thinking) fragments of the same launch and
  subagent into one row; the Daemon delivers one statement in several frames.
- The Activity log is complete: show every persisted frame, including
  `tool_end`, `thinking_end`, and `compaction_finished` as status rows. The
  Daemon's `detail` wins; fall back to the "… finished" wording only when
  `detail` is empty.
- The avatar's recent-activity popover shows noteworthy events only: it
  excludes those end frames (`POPOVER_EXCLUDED_DETAIL_KINDS`) and run-start
  markers (`isRunStartMarker`). The Agent detail Activity tab and the profile
  panel's Activity tab show the full log through the same timeline component
  (the `compact` prop), not a second component.

## Members page

- Tab counts are directory totals. Directory pages come from server cursor
  pages that filter by owner and search in the database; do not
  filter loaded pages on the client.
- Clicking an Agent name opens the same right-hand `AgentProfilePanel` the
  conversation slot uses (`profile`/`agentTab` search params);
  `/agents/$agentId` redirects there.
- Computer prerequisites appear only after the user requests Agent creation.
  Runtime management stays in the profile panel, not the directory.
- Workspace directory reads belong to
  `features/workspaces/workspaces.functions.ts` and
  `server/workspaces/members.server.ts`; owner-only Agent operations stay
  separate.
- The per-User weekly-report assistant is an internal Agent identity excluded
  from this directory; its Computer/Runtime setup reuses the panel.

## Controls and profile

- Profile control buttons submit without waiting UI or control-state queries;
  runtime observations stay in Activity. Full Reset requires destructive
  confirmation.
- The profile control (`agent-runtime-controls.ts`) chooses Start or Stop by
  `agentDisplay(display).isOnline`. Start submits immediately; Stop opens a confirm dialog. The `stopped` option
  of `agentDisplay()` only adds an un-internationalized `statusDetail` caption
  when the display is already offline; it never changes `isOnline` or the badge
  label.
- `deleted-agent.tsx` owns deleted-sender rendering (grey avatar and `DELETED`
  badge) for every message-history surface. Use it rather than local styling.
- `agent-visibility.ts` holds the `AgentVisibility` vocabulary outside any
  `.server.ts` file so browser validators can import it.
- The environment editor edits only user-declared Agent environment overrides.
- The Skills tab displays Global/Workspace metadata only, never skill bodies
  or a claim that a running session has loaded each entry.
- The context popover is display-only: no thresholds and no toast; every
  non-available Daemon status is shown inline with what to do.
