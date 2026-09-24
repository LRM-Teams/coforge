-- CreateTable
CREATE TABLE "pending_mention_actions" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "senderMemberId" UUID NOT NULL,
    "targetUserId" UUID,
    "targetAgentId" UUID,
    "targetHandle" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_mention_actions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pending_mention_actions_one_target_check"
      CHECK (("targetUserId" IS NULL) <> ("targetAgentId" IS NULL)),
    CONSTRAINT "pending_mention_actions_resolved_action_check"
      CHECK (("resolvedAt" IS NULL AND "resolvedAction" IS NULL)
        OR ("resolvedAt" IS NOT NULL AND "resolvedAction" IN ('add')))
);

-- CreateIndex
CREATE INDEX "pending_mention_actions_senderMemberId_resolvedAt_expiresAt_idx" ON "pending_mention_actions"("senderMemberId", "resolvedAt", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "pending_mention_actions_messageId_targetUserId_key" ON "pending_mention_actions"("messageId", "targetUserId");

-- CreateIndex
CREATE UNIQUE INDEX "pending_mention_actions_messageId_targetAgentId_key" ON "pending_mention_actions"("messageId", "targetAgentId");

-- AddForeignKey
ALTER TABLE "pending_mention_actions" ADD CONSTRAINT "pending_mention_actions_messageId_conversationId_fkey" FOREIGN KEY ("messageId", "conversationId") REFERENCES "messages"("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_mention_actions" ADD CONSTRAINT "pending_mention_actions_senderMemberId_conversationId_work_fkey" FOREIGN KEY ("senderMemberId", "conversationId", "workspaceId") REFERENCES "conversation_members"("id", "conversationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_mention_actions" ADD CONSTRAINT "pending_mention_actions_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_mention_actions" ADD CONSTRAINT "pending_mention_actions_targetAgentId_workspaceId_fkey" FOREIGN KEY ("targetAgentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
