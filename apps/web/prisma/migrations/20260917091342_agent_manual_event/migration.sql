-- CreateTable
CREATE TABLE "agent_manual_events" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "topicOrQuery" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "resultSlugs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_manual_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_manual_events_workspaceId_createdAt_idx" ON "agent_manual_events"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_manual_events_agentId_createdAt_idx" ON "agent_manual_events"("agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "agent_manual_events" ADD CONSTRAINT "agent_manual_events_agentId_workspaceId_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_manual_events" ADD CONSTRAINT "agent_manual_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
