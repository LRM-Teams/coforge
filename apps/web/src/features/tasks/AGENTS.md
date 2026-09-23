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
- Cards and list rows carry no status select: the column or group is the
  status. Moves go through drag or the card menu's "Move to" section, which
  both offer every move `getTaskMoveCommand` allows.
- Overview membership metadata only controls which UI actions are offered;
  the server still authorizes each command.
- The task popup (`task-detail-dialog.tsx`) offers only the status moves in
  `STATUS_TRANSITIONS` (`task-move.ts`); board drags keep every move the
  server allows. Its thread comes from the conversation that opens it, so the
  board and overview popups show no thread.
