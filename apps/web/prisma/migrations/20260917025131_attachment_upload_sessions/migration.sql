-- CreateTable
CREATE TABLE "attachment_upload_sessions" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "attachmentId" UUID NOT NULL,
    "objectKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "clientRequestId" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "terminalReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attachment_upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attachment_upload_sessions_attachmentId_key" ON "attachment_upload_sessions"("attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_upload_sessions_objectKey_key" ON "attachment_upload_sessions"("objectKey");

-- CreateIndex
CREATE INDEX "attachment_upload_sessions_conversationId_workspaceId_idx" ON "attachment_upload_sessions"("conversationId", "workspaceId");

-- CreateIndex
CREATE INDEX "attachment_upload_sessions_expiresAt_idx" ON "attachment_upload_sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_upload_sessions_agentId_clientRequestId_key" ON "attachment_upload_sessions"("agentId", "clientRequestId");

-- AddForeignKey
ALTER TABLE "attachment_upload_sessions" ADD CONSTRAINT "attachment_upload_sessions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_upload_sessions" ADD CONSTRAINT "attachment_upload_sessions_conversationId_workspaceId_fkey" FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "conversations"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_upload_sessions" ADD CONSTRAINT "attachment_upload_sessions_agentId_workspaceId_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
