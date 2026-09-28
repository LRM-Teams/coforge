CREATE TABLE "task_execution_sessions" (
  "id" UUID NOT NULL,
  "taskMessageId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "agentId" UUID NOT NULL,
  "nativeSessionId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'starting',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "requestId" UUID,
  "launchId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "task_execution_sessions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "agent_message_deliveries" ADD COLUMN "taskExecutionSessionId" UUID;

CREATE UNIQUE INDEX "task_execution_sessions_taskMessageId_agentId_key"
  ON "task_execution_sessions"("taskMessageId", "agentId");
CREATE INDEX "task_execution_sessions_agentId_status_idx"
  ON "task_execution_sessions"("agentId", "status");
CREATE INDEX "task_execution_sessions_workspaceId_status_createdAt_idx"
  ON "task_execution_sessions"("workspaceId", "status", "createdAt");

ALTER TABLE "task_execution_sessions"
  ADD CONSTRAINT "task_execution_sessions_taskMessageId_conversationId_fkey"
  FOREIGN KEY ("taskMessageId", "conversationId")
  REFERENCES "tasks"("messageId", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_execution_sessions"
  ADD CONSTRAINT "task_execution_sessions_agentId_workspaceId_fkey"
  FOREIGN KEY ("agentId", "workspaceId")
  REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_execution_sessions"
  ADD CONSTRAINT "task_execution_sessions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
