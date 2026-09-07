-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "threadRootId" UUID;

-- CreateTable
CREATE TABLE "thread_reads" (
    "memberId" UUID NOT NULL,
    "rootMessageId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "readThroughSequence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "thread_reads_pkey" PRIMARY KEY ("memberId","rootMessageId")
);

-- CreateIndex
CREATE INDEX "messages_conversationId_threadRootId_sequence_idx" ON "messages"("conversationId", "threadRootId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "messages_id_conversationId_key" ON "messages"("id", "conversationId");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_threadRootId_conversationId_fkey" FOREIGN KEY ("threadRootId", "conversationId") REFERENCES "messages"("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_memberId_conversationId_workspaceId_fkey" FOREIGN KEY ("memberId", "conversationId", "workspaceId") REFERENCES "conversation_members"("id", "conversationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_rootMessageId_conversationId_fkey" FOREIGN KEY ("rootMessageId", "conversationId") REFERENCES "messages"("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;
