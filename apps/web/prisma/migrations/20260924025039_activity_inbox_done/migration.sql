-- AlterTable
ALTER TABLE "conversation_members" ADD COLUMN     "doneThroughSequence" INTEGER;

-- AlterTable
ALTER TABLE "thread_reads" ADD COLUMN     "doneThroughSequence" INTEGER;

-- CreateIndex
CREATE INDEX "message_mentions_memberId_idx" ON "message_mentions"("memberId");
