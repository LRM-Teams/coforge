-- CreateTable
CREATE TABLE "thread_follows" (
    "memberId" UUID NOT NULL,
    "rootMessageId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_follows_pkey" PRIMARY KEY ("memberId","rootMessageId")
);

-- AddForeignKey
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_memberId_conversationId_workspaceId_fkey" FOREIGN KEY ("memberId", "conversationId", "workspaceId") REFERENCES "conversation_members"("id", "conversationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_rootMessageId_conversationId_fkey" FOREIGN KEY ("rootMessageId", "conversationId") REFERENCES "messages"("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;
