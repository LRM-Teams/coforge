-- CreateIndex
CREATE INDEX "tasks_workspaceId_status_updatedAt_messageId_idx" ON "tasks"("workspaceId", "status", "updatedAt" DESC, "messageId" DESC);

-- CreateIndex
CREATE INDEX "tasks_conversationId_status_updatedAt_messageId_idx" ON "tasks"("conversationId", "status", "updatedAt" DESC, "messageId" DESC);
