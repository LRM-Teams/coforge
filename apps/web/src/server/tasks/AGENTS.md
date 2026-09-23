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
- Task writes post their server notice (wording in `task-notices.server.ts`)
  through `withNotices`, which holds the conversation lock and signals open
  pages after the commit. Creation, conversion and assignment post in the
  conversation; claims, status moves and unassignment post in the Task's own
  thread. `unclaim`, `delete`, `amend`, the resource `receipt`, `history`,
  `list` and no-op writes post nothing. Only the assignment receipt is delivered,
  pushed and fanned out to unread badges; other notices reach only the
  conversation's own realtime channel.
- A null Message sender is the server identity, never a fabricated member.
  Authenticated send adapters always supply their member identity. Message
  reads and browser projections expose the server identity as `system` without
  changing Agent-send wake rules.
- Task message metadata belongs to the existing message read projections.
- `TaskBoard.overview(workspaceId, userId)` is browser-only and applies the
  existing conversation visibility rules.
