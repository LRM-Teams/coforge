-- CreateTable
CREATE TABLE "action_cards" (
    "messageId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "draftHint" TEXT,
    "preparedByAgentId" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "committedByUserId" UUID,
    "committedAt" TIMESTAMP(3),
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "action_cards_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE INDEX "action_cards_workspaceId_state_idx" ON "action_cards"("workspaceId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "action_cards_messageId_conversationId_key" ON "action_cards"("messageId", "conversationId");

-- AddForeignKey
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_messageId_conversationId_fkey" FOREIGN KEY ("messageId", "conversationId") REFERENCES "messages"("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_conversationId_workspaceId_fkey" FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "conversations"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_preparedByAgentId_workspaceId_fkey" FOREIGN KEY ("preparedByAgentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_committedByUserId_fkey" FOREIGN KEY ("committedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
