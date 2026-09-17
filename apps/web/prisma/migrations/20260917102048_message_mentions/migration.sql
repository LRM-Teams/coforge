-- CreateTable
CREATE TABLE "message_mentions" (
    "messageId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "handle" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_mentions_pkey" PRIMARY KEY ("messageId","memberId")
);

-- AddForeignKey
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_memberId_conversationId_workspaceId_fkey" FOREIGN KEY ("memberId", "conversationId", "workspaceId") REFERENCES "conversation_members"("id", "conversationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_messageId_conversationId_fkey" FOREIGN KEY ("messageId", "conversationId") REFERENCES "messages"("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;
