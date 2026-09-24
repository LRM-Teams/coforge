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
- Every status group starts expanded, and any group can be collapsed from
  its header. A collapsed group renders no cards but stays a drop target.
  The choice is not persisted.
- Every group renders its first 50 cards and adds 50 per "Show more"; never
  render a whole status at once. A paged group (Done and Closed on `/tasks`)
  renders every card it has read, since each read is at most 50, and keeps
  its own footer instead.
- `/tasks` holds only unfinished Tasks in its collection. Done and Closed come
  from `useFinishedTasks`: exact server counts for the `completed` window
  (`week` when absent, `month`, `all`) under the owner and Project picks, and
  50-per-page reads with "Load more", read again after every Task command and
  `task.changed.v1` burst. A `task` the page has not read is fetched alone
  (`loadOverviewTask`).
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
  saved. Announced Task changes (`task.changed.v1`, `task-realtime.ts`) are
  applied to the rows with `apply` in one write per burst; only an unfinished Task the
  page does not list yet reads the list again.
- The `/tasks` toolbar (`task-toolbar.tsx`) follows Linear: one "Filter"
  menu (owner, Project, status submenus) with a removable chip per filter in
  use, and one "Display" popover (board or list, and which Task fields show).
  The shown fields are a per-device preference (`task-display-fields.ts`,
  stored as the hidden fields); the server render shows every field.
- `/tasks` filters are search params, comma-separated: `owners` holds User
  or Agent ids and `projects` holds Project ids, with `none` meaning no owner
  or no Project (`task-filters.ts`).
