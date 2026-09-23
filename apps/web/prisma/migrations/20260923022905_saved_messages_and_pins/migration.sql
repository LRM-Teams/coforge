-- AlterTable
ALTER TABLE "conversation_members" ADD COLUMN     "hiddenAt" TIMESTAMP(3),
ADD COLUMN     "unreadFromSequence" INTEGER;

-- CreateTable
CREATE TABLE "saved_messages" (
    "messageId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_messages_pkey" PRIMARY KEY ("messageId","memberId")
);

-- CreateTable
CREATE TABLE "conversation_pins" (
    "conversationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_pins_pkey" PRIMARY KEY ("conversationId","memberId")
);

-- CreateIndex
CREATE INDEX "saved_messages_workspaceId_memberId_createdAt_idx" ON "saved_messages"("workspaceId", "memberId", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_pins_workspaceId_memberId_sortOrder_idx" ON "conversation_pins"("workspaceId", "memberId", "sortOrder");

-- AddForeignKey
ALTER TABLE "saved_messages" ADD CONSTRAINT "saved_messages_messageId_conversationId_fkey" FOREIGN KEY ("messageId", "conversationId") REFERENCES "messages"("id", "conversationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_messages" ADD CONSTRAINT "saved_messages_memberId_conversationId_workspaceId_fkey" FOREIGN KEY ("memberId", "conversationId", "workspaceId") REFERENCES "conversation_members"("id", "conversationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_messages" ADD CONSTRAINT "saved_messages_conversationId_workspaceId_fkey" FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "conversations"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_pins" ADD CONSTRAINT "conversation_pins_conversationId_workspaceId_fkey" FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "conversations"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_pins" ADD CONSTRAINT "conversation_pins_memberId_conversationId_workspaceId_fkey" FOREIGN KEY ("memberId", "conversationId", "workspaceId") REFERENCES "conversation_members"("id", "conversationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

