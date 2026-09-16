-- CreateTable
CREATE TABLE "message_reactions" (
    "messageId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("messageId","memberId","emoji")
);

-- CreateIndex
CREATE INDEX "message_reactions_conversationId_messageId_idx" ON "message_reactions"("conversationId", "messageId");

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_messageId_conversationId_fkey" FOREIGN KEY ("messageId", "conversationId") REFERENCES "messages"("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_memberId_conversationId_workspaceId_fkey" FOREIGN KEY ("memberId", "conversationId", "workspaceId") REFERENCES "conversation_members"("id", "conversationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
