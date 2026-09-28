-- CreateIndex
CREATE INDEX "pending_mention_actions_targetUserId_idx" ON "pending_mention_actions"("targetUserId");

-- CreateIndex
CREATE INDEX "pending_mention_actions_targetAgentId_workspaceId_idx" ON "pending_mention_actions"("targetAgentId", "workspaceId");
