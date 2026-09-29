-- CreateIndex
CREATE INDEX "agent_message_deliveries_pending_mentions_idx" ON "agent_message_deliveries"("workspaceId", "agentId") WHERE ("mentionOutcome" = 'pending');
