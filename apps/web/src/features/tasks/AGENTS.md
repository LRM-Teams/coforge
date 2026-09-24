# Tasks UI

These rules apply to `src/features/tasks/`.

- Every status edit goes through `executeTask` with claim semantics. The
  browser supplies revisions for the optional revision check; the Agent CLI
  need not.
- dnd-kit owns pointer and keyboard drag mechanics only, never authorization
  or persistence.
- Board and List views share the status-grouped layout and drag interactions
  in this directory. The `/tasks` and conversation routes own the validated
  view search state.
- Done and Closed start collapsed whenever several statuses show; a
  single-status view starts expanded. A collapsed group renders no cards but
  stays a drop target. The choice is not persisted.
- Cards and list rows carry no status select: the column or group is the
  status. Moves go through drag or the card menu's "Move to" section, which
  both offer every move `getTaskMoveCommand` allows.
- Overview membership metadata only controls which UI actions are offered;
  the server still authorizes each command.
- The task popup (`task-detail-dialog.tsx`) offers only the status moves in
  `STATUS_TRANSITIONS` (`task-move.ts`); board drags keep every move the
  server allows. Its thread comes from the Task's conversation: a
  conversation page renders it, and the `/tasks` popup
  (`overview-task-popup.tsx`) renders that conversation's own popup through
  `ThreadedConversation`'s `taskPopup` mode. Never build a second thread view
  for a popup.
- `/tasks` names its open popup as `task=<conversationId>:<number>`
  (`task-overview-search.ts`); a conversation route's `task` is the bare
  number. Opening pushes a history entry, closing replaces it.
- `/tasks` rows are a TanStack DB collection over the `["task", "overview",
workspaceId]` Query its loader fills (`task-overview-collection.ts`,
  `use-task-overview.ts`). Commands go through the collection's `run`, which
  shows a move at once and writes back the server's copy; refreshes
  invalidate that Query, never the router. A command with nothing to show
  first still reaches the server: an empty optimistic transaction is never
  saved.
- `/tasks` filters are search params, comma-separated: `owners` holds User
  or Agent ids and `projects` holds Project ids, with `none` meaning no owner
  or no Project (`task-filters.ts`).
