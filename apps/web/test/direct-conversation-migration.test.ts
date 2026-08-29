import { expect, test } from "bun:test";

const migration = await Bun.file(
  new URL(
    "../prisma/migrations/20260828000003_direct_conversations/migration.sql",
    import.meta.url,
  ),
).text();

test("direct conversation migration enforces conversation-scoped membership", () => {
  expect(migration).toContain(
    'FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "Conversation"("id", "workspaceId")',
  );
  expect(migration).toContain(
    'FOREIGN KEY ("senderMemberId", "conversationId", "workspaceId") REFERENCES "ConversationMember"("id", "conversationId", "workspaceId")',
  );
});
