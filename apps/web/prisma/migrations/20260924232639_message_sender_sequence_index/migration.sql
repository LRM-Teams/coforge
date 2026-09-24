-- CreateIndex
CREATE INDEX "messages_senderMemberId_sequence_idx" ON "messages"("senderMemberId", "sequence");
