-- CreateTable
CREATE TABLE "Agent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerUserId" TEXT NOT NULL,
    "runtimeConfig" JSONB NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_workspaceId_name_key" ON "Agent"("workspaceId", "name");
CREATE UNIQUE INDEX "Agent_id_workspaceId_key" ON "Agent"("id", "workspaceId");
CREATE INDEX "Agent_workspaceId_ownerUserId_idx" ON "Agent"("workspaceId", "ownerUserId");
CREATE INDEX "Agent_workspaceId_createdAt_idx" ON "Agent"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
