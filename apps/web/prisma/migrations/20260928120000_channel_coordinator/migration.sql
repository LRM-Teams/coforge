ALTER TABLE "conversations" ADD COLUMN "coordinatorAgentId" UUID;

CREATE INDEX "conversations_coordinatorAgentId_idx" ON "conversations"("coordinatorAgentId");

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_coordinatorAgentId_workspaceId_fkey"
  FOREIGN KEY ("coordinatorAgentId", "workspaceId") REFERENCES "agents"("id", "workspaceId")
  ON DELETE NO ACTION ON UPDATE CASCADE;
