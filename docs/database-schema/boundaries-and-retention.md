# Identity boundaries, retention, and indexing

## Identity boundaries

This draft deliberately does not define foreign keys from `workspace_id`,
`subject_id`, or `agent_id` to identity tables, because those tables are not yet
part of the repository contract. Add those foreign keys when workspace, member,
and Agent ownership schemas stabilize. Internal messaging references are fully
constrained now.

## Retention and indexing

- Use keyset pagination on `(conversation_id, seq)`; do not use timestamp offset
  pagination for message history.
- Query inbox membership through the active-participant partial index.
- Keep canonical messages long enough to satisfy read-boundary recovery and
  audit requirements. If hard deletion is required, delete reaction,
  attachment, and message data as one explicit retention workflow.
- Treat `body_json` as versioned application data. Do not use it as a substitute
  for columns needed by relational filters or integrity rules.

The DirectConversation, ConversationMember, and Message tables are included in
the `20260828000003_direct_conversations` migration. Setup-owned identity and Workspace connection tables are
implemented separately under `apps/web/prisma/schema.prisma` and its migration.
Approved
implementations use Prisma schema, generated Prisma Client, and Prisma Migrate.
That approval does not approve the draft messaging tables or their future SQL
migrations.
