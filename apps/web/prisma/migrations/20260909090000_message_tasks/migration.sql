CREATE TABLE "tasks" (
    "messageId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'todo',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "ownerMemberId" UUID,
    "creatorMemberId" UUID NOT NULL,
    "requestId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tasks_pkey" PRIMARY KEY ("messageId"),
    CONSTRAINT "tasks_status_check" CHECK ("status" IN ('todo', 'in_progress', 'in_review', 'done', 'closed'))
);

CREATE UNIQUE INDEX "tasks_conversationId_number_key" ON "tasks"("conversationId", "number");
CREATE UNIQUE INDEX "tasks_messageId_conversationId_key" ON "tasks"("messageId", "conversationId");
CREATE UNIQUE INDEX "tasks_conversationId_creatorMemberId_requestId_key" ON "tasks"("conversationId", "creatorMemberId", "requestId");
CREATE INDEX "tasks_workspaceId_conversationId_status_idx" ON "tasks"("workspaceId", "conversationId", "status");
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_messageId_conversationId_fkey" FOREIGN KEY ("messageId", "conversationId") REFERENCES "messages"("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_conversationId_workspaceId_fkey" FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "conversations"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_ownerMemberId_conversationId_workspaceId_fkey" FOREIGN KEY ("ownerMemberId", "conversationId", "workspaceId") REFERENCES "conversation_members"("id", "conversationId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_creatorMemberId_conversationId_workspaceId_fkey" FOREIGN KEY ("creatorMemberId", "conversationId", "workspaceId") REFERENCES "conversation_members"("id", "conversationId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
