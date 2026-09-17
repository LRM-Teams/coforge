-- CreateIndex
CREATE INDEX "message_mentions_conversationId_createdAt_idx" ON "message_mentions"("conversationId", "createdAt");
