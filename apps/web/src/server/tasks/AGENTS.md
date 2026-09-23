# Task board

These rules apply to `src/server/tasks/`. The framework-free shared Task
contract is `packages/coforge-sdk/src/internal/tasks.ts`.

- `TaskBoard.execute(principal, command)` is the single place for Task
  authorization, atomic message and Task creation, numbering, exclusive claims,
  assignment, card amendments and history, resource receipts, and status
  writes. Agent Task RPC adapters under `server/agents/` call the same
  TaskBoard and never duplicate its business rules.
- Resource expiry follow-up uses the existing Reminder persistence and
  synchronization. Never add a second task scheduler.
- TaskBoard creates the server-authored assignment Message and the assignee's
  delivery eligibility in the same transaction.
- Every Task change posts its server notice (wording in `task-notices.server.ts`)
  in the same transaction, under the conversation lock: creation, conversion and
  assignment in the conversation; claims, status moves, unassignment, release
  and deletion in the Task's own thread. Only the assignment receipt carries a
  delivery; every other notice wakes no one.
- A null Message sender is the server identity, never a fabricated member.
  Authenticated send adapters always supply their member identity. Message
  reads and browser projections expose the server identity as `system` without
  changing Agent-send wake rules.
- Task message metadata belongs to the existing message read projections.
- `TaskBoard.overview(workspaceId, userId)` is browser-only and applies the
  existing conversation visibility rules.
