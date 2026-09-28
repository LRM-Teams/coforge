-- CreateIndex
CREATE INDEX "messages_workspaceId_createdAt_id_idx" ON "messages"("workspaceId", "createdAt" DESC, "id" DESC);
