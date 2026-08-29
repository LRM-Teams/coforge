CREATE TABLE "AgentActivity" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "agentId" UUID NOT NULL,
  "computerId" UUID NOT NULL,
  "launchId" TEXT NOT NULL,
  "clientSeq" INTEGER NOT NULL,
  "activity" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentActivity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentActivity_agent_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "Agent"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AgentActivity_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AgentActivity_computer_fkey" FOREIGN KEY ("computerId") REFERENCES "Computer"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentActivity_agentId_launchId_clientSeq_key" ON "AgentActivity"("agentId", "launchId", "clientSeq");
CREATE INDEX "AgentActivity_workspaceId_agentId_occurredAt_clientSeq_idx" ON "AgentActivity"("workspaceId", "agentId", "occurredAt" DESC, "clientSeq" DESC);
