CREATE TABLE "Conversation" (
  "id" UUID NOT NULL, "workspaceId" UUID NOT NULL, "directKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Conversation_id_workspaceId_key" ON "Conversation"("id", "workspaceId");
CREATE TABLE "ConversationMember" (
  "id" UUID NOT NULL, "conversationId" UUID NOT NULL, "workspaceId" UUID NOT NULL,
  "userId" UUID, "agentId" UUID,
  CONSTRAINT "ConversationMember_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConversationMember_subject_check" CHECK (("userId" IS NOT NULL) <> ("agentId" IS NOT NULL)),
  CONSTRAINT "ConversationMember_conversation_workspace_fkey" FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "Conversation"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConversationMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConversationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConversationMember_agent_workspace_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "Agent"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConversationMember_id_conversationId_workspaceId_key" ON "ConversationMember"("id", "conversationId", "workspaceId");
CREATE TABLE "Message" (
  "id" UUID NOT NULL, "conversationId" UUID NOT NULL, "workspaceId" UUID NOT NULL, "senderMemberId" UUID NOT NULL,
  "body" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Message_conversation_workspace_fkey" FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "Conversation"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Message_sender_member_conversation_workspace_fkey" FOREIGN KEY ("senderMemberId", "conversationId", "workspaceId") REFERENCES "ConversationMember"("id", "conversationId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Conversation_workspaceId_directKey_key" ON "Conversation"("workspaceId", "directKey");
CREATE UNIQUE INDEX "ConversationMember_conversationId_userId_key" ON "ConversationMember"("conversationId", "userId");
CREATE UNIQUE INDEX "ConversationMember_conversationId_agentId_key" ON "ConversationMember"("conversationId", "agentId");
CREATE INDEX "Conversation_workspaceId_idx" ON "Conversation"("workspaceId");
CREATE INDEX "ConversationMember_workspaceId_userId_idx" ON "ConversationMember"("workspaceId", "userId");
CREATE INDEX "ConversationMember_workspaceId_agentId_idx" ON "ConversationMember"("workspaceId", "agentId");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
