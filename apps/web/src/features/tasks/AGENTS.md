# Tasks UI

These rules apply to `src/features/tasks/`.

- Every status edit goes through `executeTask` with claim semantics. The
  browser supplies revisions for the optional revision check; the Agent CLI
  need not.
- dnd-kit owns pointer and keyboard drag mechanics only, never authorization
  or persistence.
- The Workspace Tasks page and a conversation's Tasks tab are one component,
  `TaskBoard` (`task-board.tsx`), with one card: the same toolbar, board or
  list, moves and paged Done and Closed. Only the page has its page header
  and shows each Task's source and Project (filter, pill, Display field); only
  a conversation (`ConversationTaskBoard`) creates Tasks. Cards carry no
  Claim or Unclaim button: moving an unowned To do Task to In progress claims
  it (`getTaskMoveCommand`).
- Both routes spread `taskBoardSearchShape` (`task-board-search.ts`) into
  their validated search and read it with `useTaskBoardSearch`: `status`,
  `layout`, `owners`, `projects`, `completed`. A status or layout change is a
  history entry; picks and the window replace the address in place.
- Every status group starts expanded, and any group can be collapsed from
  its header. A collapsed group renders no cards but stays a drop target.
  The choice is not persisted.
- Every group renders its first 50 cards and adds 50 per "Show more"; never
  render a whole status at once. A paged group (Done and Closed on `/tasks`)
  renders every card it has read, since each read is at most 50, and keeps
  its own footer instead.
- Done and Closed come from `useFinishedTasks`, scoped to the Workspace page
  or one conversation: exact server counts for the `completed` window (`week`
  when absent, `month`, `all`) under the owner and Project picks, and
  50-per-page reads with "Load more", read again after every Task command and
  `task.changed.v1`. A board holds a finished Task itself only once it showed
  it unfinished (moved there since). `/tasks` holds only unfinished Tasks in
  its collection, and a `task` the page has not read is fetched alone
  (`loadOverviewTask`). A conversation's own list still reads every Task; the
  tab keeps the unfinished ones.
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
- The board's toolbar (`task-toolbar.tsx`) follows Linear: one "Filter"
  menu (owner, Project, status submenus) with a removable chip per filter in
  use, and one "Display" popover (board or list, the finished-task window, and
  which Task fields show).
  The shown fields are a per-device preference
  (`features/settings/task-display-fields.ts`, stored as the hidden fields)
  applied as classes on `<html>` by the boot script, so cards inside
  `[data-task-board]` follow by CSS alone and never flash or re-render.
- Filters are search params, comma-separated: `owners` holds User or Agent
  ids and `projects` holds Project ids, with `none` meaning no owner or no
  Project (`task-filters.ts`).
- Rows and cards follow Linear: a status is `TaskStatusIcon` (a ring that
  fills as work advances, colours from `TASK_STATUS_COLOR`); list rows are one
  line (number, status, title, source and Project pills, owner avatar); cards
  put number and source over the title with the owner avatar beside them.
- Board columns can be hidden from their "···" menu, as Linear allows; hidden
  ones are listed last (`HiddenColumn`), stay drop targets, and show again when
  pressed. Every column shows by default; the choice is per device
  (`features/settings/task-hidden-columns.ts`, on the shared
  `device-preference.ts` store) and a boot-script class, so a hidden column
  never flashes while hydrating and never reads its pages.
- `/tasks` shows channel Tasks only; a direct message's Tasks, the viewer's
  own included, stay on that conversation's Tasks tab (the server scopes every
  Workspace-page read, so its realtime listens on the Workspace channel only).
  The page creates no Tasks: new ones start from a conversation's Tasks tab
  (`CreateTaskDialog`), titles only, several at once in one `create` with
  `titles`, so all of them are created or none.
