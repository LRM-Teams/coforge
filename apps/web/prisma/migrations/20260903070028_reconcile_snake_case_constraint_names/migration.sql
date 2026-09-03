-- DropForeignKey
ALTER TABLE "agent_api_keys" DROP CONSTRAINT "AgentApiKey_agent_fkey";

-- DropForeignKey
ALTER TABLE "agent_api_keys" DROP CONSTRAINT "AgentApiKey_computer_fkey";

-- DropForeignKey
ALTER TABLE "agent_api_keys" DROP CONSTRAINT "AgentApiKey_owner_fkey";

-- DropForeignKey
ALTER TABLE "agent_api_keys" DROP CONSTRAINT "AgentApiKey_workspace_fkey";

-- DropForeignKey
ALTER TABLE "agents" DROP CONSTRAINT "Agent_ownerId_fkey";

-- DropForeignKey
ALTER TABLE "computers" DROP CONSTRAINT "Computer_ownerId_fkey";

-- AlterTable
ALTER TABLE "agent_activities" RENAME CONSTRAINT "AgentActivity_pkey" TO "agent_activities_pkey";

-- AlterTable
ALTER TABLE "agent_api_keys" RENAME CONSTRAINT "AgentApiKey_pkey" TO "agent_api_keys_pkey";

-- AlterTable
ALTER TABLE "agent_message_deliveries" RENAME CONSTRAINT "AgentMessageDelivery_pkey" TO "agent_message_deliveries_pkey";

-- AlterTable
ALTER TABLE "agents" RENAME CONSTRAINT "Agent_pkey" TO "agents_pkey";

-- AlterTable
ALTER TABLE "attachments" RENAME CONSTRAINT "Attachment_pkey" TO "attachments_pkey";

-- AlterTable
ALTER TABLE "computer_model_catalogs" RENAME CONSTRAINT "ComputerModelCatalog_pkey" TO "computer_model_catalogs_pkey";

-- AlterTable
ALTER TABLE "computer_runtimes" ALTER COLUMN "displayName" DROP DEFAULT;
ALTER TABLE "computer_runtimes" RENAME CONSTRAINT "ComputerRuntime_pkey" TO "computer_runtimes_pkey";

-- AlterTable
ALTER TABLE "computers" RENAME CONSTRAINT "Computer_pkey" TO "computers_pkey";

-- AlterTable
ALTER TABLE "conversation_members" RENAME CONSTRAINT "ConversationMember_pkey" TO "conversation_members_pkey";

-- AlterTable
ALTER TABLE "conversations" RENAME CONSTRAINT "Conversation_pkey" TO "conversations_pkey";

-- AlterTable
ALTER TABLE "messages" ALTER COLUMN "sequence" DROP DEFAULT;
ALTER TABLE "messages" RENAME CONSTRAINT "Message_pkey" TO "messages_pkey";

-- AlterTable
ALTER TABLE "user_identities" RENAME CONSTRAINT "UserIdentity_pkey" TO "user_identities_pkey";

-- AlterTable
ALTER TABLE "users" RENAME CONSTRAINT "User_pkey" TO "users_pkey";

-- AlterTable
ALTER TABLE "workspace_computers" RENAME CONSTRAINT "WorkspaceComputer_pkey" TO "workspace_computers_pkey";

-- AlterTable
ALTER TABLE "workspace_memberships" RENAME CONSTRAINT "WorkspaceMembership_pkey" TO "workspace_memberships_pkey";

-- AlterTable
ALTER TABLE "workspaces" RENAME CONSTRAINT "Workspace_pkey" TO "workspaces_pkey";

-- CreateIndex
CREATE INDEX "workspace_memberships_userId_idx" ON "workspace_memberships"("userId");

-- RenameForeignKey
ALTER TABLE "agent_activities" RENAME CONSTRAINT "AgentActivity_agent_fkey" TO "agent_activities_agentId_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "agent_activities" RENAME CONSTRAINT "AgentActivity_computer_fkey" TO "agent_activities_computerId_fkey";

-- RenameForeignKey
ALTER TABLE "agent_activities" RENAME CONSTRAINT "AgentActivity_workspace_fkey" TO "agent_activities_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "agent_message_deliveries" RENAME CONSTRAINT "AgentMessageDelivery_agent_workspace_fkey" TO "agent_message_deliveries_agentId_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "agent_message_deliveries" RENAME CONSTRAINT "AgentMessageDelivery_conversation_workspace_fkey" TO "agent_message_deliveries_conversationId_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "agent_message_deliveries" RENAME CONSTRAINT "AgentMessageDelivery_messageId_fkey" TO "agent_message_deliveries_messageId_fkey";

-- RenameForeignKey
ALTER TABLE "agent_message_deliveries" RENAME CONSTRAINT "AgentMessageDelivery_workspaceId_fkey" TO "agent_message_deliveries_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "agents" RENAME CONSTRAINT "Agent_computerId_fkey" TO "agents_computerId_fkey";

-- RenameForeignKey
ALTER TABLE "agents" RENAME CONSTRAINT "Agent_workspaceId_fkey" TO "agents_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "attachments" RENAME CONSTRAINT "Attachment_conversationId_workspaceId_fkey" TO "attachments_conversationId_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "attachments" RENAME CONSTRAINT "Attachment_messageId_fkey" TO "attachments_messageId_fkey";

-- RenameForeignKey
ALTER TABLE "attachments" RENAME CONSTRAINT "Attachment_uploaderId_fkey" TO "attachments_uploaderId_fkey";

-- RenameForeignKey
ALTER TABLE "attachments" RENAME CONSTRAINT "Attachment_workspaceId_fkey" TO "attachments_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "computer_model_catalogs" RENAME CONSTRAINT "ComputerModelCatalog_computerId_fkey" TO "computer_model_catalogs_computerId_fkey";

-- RenameForeignKey
ALTER TABLE "computer_runtimes" RENAME CONSTRAINT "ComputerRuntime_computerId_fkey" TO "computer_runtimes_computerId_fkey";

-- RenameForeignKey
ALTER TABLE "conversation_members" RENAME CONSTRAINT "ConversationMember_agent_workspace_fkey" TO "conversation_members_agentId_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "conversation_members" RENAME CONSTRAINT "ConversationMember_conversation_workspace_fkey" TO "conversation_members_conversationId_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "conversation_members" RENAME CONSTRAINT "ConversationMember_userId_fkey" TO "conversation_members_userId_fkey";

-- RenameForeignKey
ALTER TABLE "conversation_members" RENAME CONSTRAINT "ConversationMember_workspaceId_fkey" TO "conversation_members_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "conversations" RENAME CONSTRAINT "Conversation_workspaceId_fkey" TO "conversations_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "messages" RENAME CONSTRAINT "Message_conversation_workspace_fkey" TO "messages_conversationId_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "messages" RENAME CONSTRAINT "Message_sender_member_conversation_workspace_fkey" TO "messages_senderMemberId_conversationId_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "user_identities" RENAME CONSTRAINT "UserIdentity_userId_fkey" TO "user_identities_userId_fkey";

-- RenameForeignKey
ALTER TABLE "workspace_computers" RENAME CONSTRAINT "WorkspaceComputer_computerId_fkey" TO "workspace_computers_computerId_fkey";

-- RenameForeignKey
ALTER TABLE "workspace_computers" RENAME CONSTRAINT "WorkspaceComputer_workspaceId_fkey" TO "workspace_computers_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "workspace_memberships" RENAME CONSTRAINT "WorkspaceMembership_userId_fkey" TO "workspace_memberships_userId_fkey";

-- RenameForeignKey
ALTER TABLE "workspace_memberships" RENAME CONSTRAINT "WorkspaceMembership_workspaceId_fkey" TO "workspace_memberships_workspaceId_fkey";

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_agentId_workspaceId_fkey" FOREIGN KEY ("agentId", "workspaceId") REFERENCES "agents"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "computers" ADD CONSTRAINT "computers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "AgentActivity_agentId_launchId_clientSeq_key" RENAME TO "agent_activities_agentId_launchId_clientSeq_key";

-- RenameIndex
ALTER INDEX "AgentActivity_workspaceId_agentId_occurredAt_clientSeq_idx" RENAME TO "agent_activities_workspaceId_agentId_occurredAt_clientSeq_idx";

-- RenameIndex
ALTER INDEX "AgentApiKey_agentId_workspaceId_idx" RENAME TO "agent_api_keys_agentId_workspaceId_idx";

-- RenameIndex
ALTER INDEX "AgentApiKey_apiKeyHash_key" RENAME TO "agent_api_keys_apiKeyHash_key";

-- RenameIndex
ALTER INDEX "AgentApiKey_computerId_idx" RENAME TO "agent_api_keys_computerId_idx";

-- RenameIndex
ALTER INDEX "AgentApiKey_ownerId_idx" RENAME TO "agent_api_keys_ownerId_idx";

-- RenameIndex
ALTER INDEX "AgentMessageDelivery_deliveryId_workspaceId_key" RENAME TO "agent_message_deliveries_deliveryId_workspaceId_key";

-- RenameIndex
ALTER INDEX "AgentMessageDelivery_messageId_agentId_key" RENAME TO "agent_message_deliveries_messageId_agentId_key";

-- RenameIndex
ALTER INDEX "AgentMessageDelivery_workspaceId_agentId_receivedAt_idx" RENAME TO "agent_message_deliveries_workspaceId_agentId_receivedAt_idx";

-- RenameIndex
ALTER INDEX "Agent_computerId_idx" RENAME TO "agents_computerId_idx";

-- RenameIndex
ALTER INDEX "Agent_id_workspaceId_key" RENAME TO "agents_id_workspaceId_key";

-- RenameIndex
ALTER INDEX "Agent_workspaceId_createdAt_idx" RENAME TO "agents_workspaceId_createdAt_idx";

-- RenameIndex
ALTER INDEX "Agent_workspaceId_name_key" RENAME TO "agents_workspaceId_name_key";

-- RenameIndex
ALTER INDEX "Agent_workspaceId_ownerUserId_idx" RENAME TO "agents_workspaceId_ownerId_idx";

-- RenameIndex
ALTER INDEX "Attachment_conversationId_workspaceId_idx" RENAME TO "attachments_conversationId_workspaceId_idx";

-- RenameIndex
ALTER INDEX "Attachment_messageId_key" RENAME TO "attachments_messageId_key";

-- RenameIndex
ALTER INDEX "Attachment_objectKey_key" RENAME TO "attachments_objectKey_key";

-- RenameIndex
ALTER INDEX "Attachment_uploaderId_idx" RENAME TO "attachments_uploaderId_idx";

-- RenameIndex
ALTER INDEX "ComputerModelCatalog_computerId_idx" RENAME TO "computer_model_catalogs_computerId_idx";

-- RenameIndex
ALTER INDEX "ComputerModelCatalog_computerId_provider_key" RENAME TO "computer_model_catalogs_computerId_provider_key";

-- RenameIndex
ALTER INDEX "ComputerRuntime_computerId_idx" RENAME TO "computer_runtimes_computerId_idx";

-- RenameIndex
ALTER INDEX "ComputerRuntime_computerId_provider_key" RENAME TO "computer_runtimes_computerId_provider_key";

-- RenameIndex
ALTER INDEX "Computer_ownerId_machineId_key" RENAME TO "computers_ownerId_machineId_key";

-- RenameIndex
ALTER INDEX "ConversationMember_conversationId_agentId_key" RENAME TO "conversation_members_conversationId_agentId_key";

-- RenameIndex
ALTER INDEX "ConversationMember_conversationId_userId_key" RENAME TO "conversation_members_conversationId_userId_key";

-- RenameIndex
ALTER INDEX "ConversationMember_id_conversationId_workspaceId_key" RENAME TO "conversation_members_id_conversationId_workspaceId_key";

-- RenameIndex
ALTER INDEX "ConversationMember_workspaceId_agentId_idx" RENAME TO "conversation_members_workspaceId_agentId_idx";

-- RenameIndex
ALTER INDEX "ConversationMember_workspaceId_userId_idx" RENAME TO "conversation_members_workspaceId_userId_idx";

-- RenameIndex
ALTER INDEX "Conversation_id_workspaceId_key" RENAME TO "conversations_id_workspaceId_key";

-- RenameIndex
ALTER INDEX "Conversation_workspaceId_directKey_key" RENAME TO "conversations_workspaceId_directKey_key";

-- RenameIndex
ALTER INDEX "Conversation_workspaceId_idx" RENAME TO "conversations_workspaceId_idx";

-- RenameIndex
ALTER INDEX "Message_conversationId_createdAt_idx" RENAME TO "messages_conversationId_createdAt_idx";

-- RenameIndex
ALTER INDEX "Message_conversationId_sequence_key" RENAME TO "messages_conversationId_sequence_key";

-- RenameIndex
ALTER INDEX "UserIdentity_provider_providerSubject_key" RENAME TO "user_identities_provider_providerSubject_key";

-- RenameIndex
ALTER INDEX "UserIdentity_userId_idx" RENAME TO "user_identities_userId_idx";

-- RenameIndex
ALTER INDEX "User_username_key" RENAME TO "users_username_key";

-- RenameIndex
ALTER INDEX "WorkspaceComputer_workspaceId_computerId_key" RENAME TO "workspace_computers_workspaceId_computerId_key";

-- RenameIndex
ALTER INDEX "Workspace_slug_key" RENAME TO "workspaces_slug_key";
