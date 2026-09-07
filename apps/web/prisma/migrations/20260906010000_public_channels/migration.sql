-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "channelName" TEXT,
ALTER COLUMN "directKey" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "conversations_workspaceId_channelName_key" ON "conversations"("workspaceId", "channelName");

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_destination_check"
CHECK (("directKey" IS NOT NULL) <> ("channelName" IS NOT NULL));

-- Existing Workspaces receive one public general channel and human memberships.
INSERT INTO "conversations" ("id", "workspaceId", "channelName")
SELECT gen_random_uuid(), "id", 'general' FROM "workspaces";

INSERT INTO "conversation_members" ("id", "conversationId", "workspaceId", "userId")
SELECT gen_random_uuid(), c."id", m."workspaceId", m."userId"
FROM "workspace_memberships" m
JOIN "conversations" c ON c."workspaceId" = m."workspaceId" AND c."channelName" = 'general';
