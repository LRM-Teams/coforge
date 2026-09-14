ALTER TABLE "tasks"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "createsResource" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "resourceReceipt" JSONB,
  ADD COLUMN "resourceReceiptRecordedAt" TIMESTAMP(3),
  ADD COLUMN "resourceTeardownOwnerAgentId" UUID,
  ADD COLUMN "resourceExpiryFollowupId" UUID;

ALTER TABLE "conversations" ADD COLUMN "nextTaskNumber" INTEGER NOT NULL DEFAULT 1;
UPDATE "conversations" AS c
SET "nextTaskNumber" = COALESCE(
  (SELECT MAX(t."number") + 1 FROM "tasks" AS t WHERE t."conversationId" = c."id"),
  1
);

CREATE TABLE "task_history_events" (
  "id" UUID NOT NULL,
  "taskMessageId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "actorKind" TEXT NOT NULL,
  "actorName" TEXT,
  "beforeTitle" TEXT,
  "afterTitle" TEXT,
  "beforeDescription" TEXT,
  "afterDescription" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_history_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_history_events_taskMessageId_fkey" FOREIGN KEY ("taskMessageId") REFERENCES "tasks"("messageId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "task_history_events_taskMessageId_sequence_key" ON "task_history_events"("taskMessageId", "sequence");
CREATE INDEX "task_history_events_taskMessageId_createdAt_idx" ON "task_history_events"("taskMessageId", "createdAt");
