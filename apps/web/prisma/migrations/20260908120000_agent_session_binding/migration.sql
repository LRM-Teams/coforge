-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "currentSessionId" UUID,
ADD COLUMN     "controlState" JSONB;

-- CreateTable
CREATE TABLE "agent_sessions" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "computerId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "nativeSessionId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'unknown',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_sessions_agentId_createdAt_idx" ON "agent_sessions"("agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_currentSessionId_fkey" FOREIGN KEY ("currentSessionId") REFERENCES "agent_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agentId_workspaceId_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
