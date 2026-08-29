ALTER TABLE "Message" ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "Message_conversationId_sequence_key" ON "Message"("conversationId", "sequence");
CREATE TABLE "AgentMessageDelivery" (
  "deliveryId" UUID NOT NULL,
  "messageId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "agentId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "receivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentMessageDelivery_pkey" PRIMARY KEY ("deliveryId"),
  CONSTRAINT "AgentMessageDelivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AgentMessageDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AgentMessageDelivery_agent_workspace_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "Agent"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AgentMessageDelivery_conversation_workspace_fkey" FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "Conversation"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentMessageDelivery_messageId_agentId_key" ON "AgentMessageDelivery"("messageId", "agentId");
CREATE UNIQUE INDEX "AgentMessageDelivery_deliveryId_workspaceId_key" ON "AgentMessageDelivery"("deliveryId", "workspaceId");
CREATE INDEX "AgentMessageDelivery_workspaceId_agentId_receivedAt_idx" ON "AgentMessageDelivery"("workspaceId", "agentId", "receivedAt");
