-- CreateIndex
CREATE INDEX "thread_reads_rootMessageId_conversationId_idx" ON "thread_reads"("rootMessageId", "conversationId");

-- CreateIndex
CREATE INDEX "thread_follows_rootMessageId_conversationId_idx" ON "thread_follows"("rootMessageId", "conversationId");
