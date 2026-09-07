-- AlterTable
ALTER TABLE "conversation_members" ADD COLUMN     "channelMuted" BOOLEAN NOT NULL DEFAULT false;

-- Existing Agents join the default channel without backfilling historical delivery.
INSERT INTO "conversation_members" ("id", "conversationId", "workspaceId", "agentId")
SELECT gen_random_uuid(), c."id", a."workspaceId", a."id"
FROM "agents" a
JOIN "conversations" c ON c."workspaceId" = a."workspaceId" AND c."channelName" = 'general'
ON CONFLICT ("conversationId", "agentId") DO NOTHING;
