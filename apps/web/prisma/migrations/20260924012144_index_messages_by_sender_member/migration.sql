-- CreateIndex
CREATE INDEX "messages_senderMemberId_threadRootId_sequence_idx" ON "messages"("senderMemberId", "threadRootId", "sequence");
