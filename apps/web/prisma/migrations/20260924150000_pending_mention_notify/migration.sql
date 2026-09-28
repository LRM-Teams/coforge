-- AlterTable
ALTER TABLE "pending_mention_actions" ADD COLUMN "notifiedAt" TIMESTAMP(3),
ADD COLUMN "dismissedAt" TIMESTAMP(3),
ADD COLUMN "targetReadAt" TIMESTAMP(3);
