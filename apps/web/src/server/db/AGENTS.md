# Database client and repositories

These rules apply to `src/server/db/`.

- Use parameterized Prisma queries. Use `$queryRaw`/`$executeRaw` only for a
  reviewed PostgreSQL-specific requirement, and keep that SQL in a server-only
  repository or migration.
- Agent repositories persist only the completed runtime configuration;
  runtime selection and credential encryption stay in `server/agents/`.
- `reminder.repositories.server.ts` owns PostgreSQL locking and persistence
  only; authorization, recurrence, and fire idempotence stay in
  `server/reminders/`.
- Code Agent installation inventory (`computer-runtime.repositories.server.ts`)
  is keyed and queried by the trusted `(workspaceId, computerId)` connection. A
  Computer shared with another Workspace must not share publication state or
  model-catalog rows.
- `agent-deletion.repositories.server.ts` makes a deleted Agent inert in one
  transaction; keep every deletion write inside it.
- `direct-conversation-preferences.repositories.server.ts` owns the viewer's
  DM list preferences (pinned, marked unread, closed) and their sidebar read.
  It finds the DM through `PrismaDirectConversationRepository` and never
  creates one; that repository keeps the DM's messages and read cursors and
  forwards its preference methods here.
- `agent-target-context.repositories.server.ts` owns the reads an Agent send
  is checked against for one resolved target: pending attention above a
  boundary, its count from the same scope, and first-touch recent context. It
  takes a target `PrismaDirectConversationRepository` already resolved; that
  repository keeps resolution and the Agent read-position advance.
