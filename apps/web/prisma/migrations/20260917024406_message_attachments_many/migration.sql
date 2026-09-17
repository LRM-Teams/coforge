-- DropIndex
DROP INDEX "attachments_messageId_key";

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "attachments_messageId_position_idx" ON "attachments"("messageId", "position");
