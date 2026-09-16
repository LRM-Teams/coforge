DROP INDEX "conversations_projectId_key";

CREATE INDEX "conversations_projectId_idx" ON "conversations"("projectId");
