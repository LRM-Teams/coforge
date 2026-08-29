CREATE TABLE "AgentApiKey" (
  "id" UUID NOT NULL,
  "apiKeyHash" TEXT NOT NULL,
  "agentId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "computerId" UUID NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "disabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentApiKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentApiKey_apiKeyHash_key" UNIQUE ("apiKeyHash"),
  CONSTRAINT "AgentApiKey_agent_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "Agent"("id", "workspaceId") ON DELETE CASCADE,
  CONSTRAINT "AgentApiKey_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE,
  CONSTRAINT "AgentApiKey_owner_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "AgentApiKey_computer_fkey" FOREIGN KEY ("computerId") REFERENCES "Computer"("id") ON DELETE CASCADE
);
CREATE INDEX "AgentApiKey_agentId_workspaceId_idx" ON "AgentApiKey"("agentId", "workspaceId");
CREATE INDEX "AgentApiKey_ownerId_idx" ON "AgentApiKey"("ownerId");
CREATE INDEX "AgentApiKey_computerId_idx" ON "AgentApiKey"("computerId");
