-- AlterTable
ALTER TABLE "weekly_report_assistant_chat_sessions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "weekly_report_assistant_runtime_sessions" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "weekly_report_assistant_runtime_sessions" RENAME CONSTRAINT "weekly_report_asst_runtime_sessions_pkey" TO "weekly_report_assistant_runtime_sessions_pkey";

-- AlterTable
ALTER TABLE "weekly_report_collect_runs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "weekly_report_collect_slots" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "weekly_report_collector_bindings" ALTER COLUMN "id" DROP DEFAULT;

-- RenameForeignKey
ALTER TABLE "weekly_report_assistant_runtime_sessions" RENAME CONSTRAINT "weekly_report_asst_runtime_agent_fkey" TO "weekly_report_assistant_runtime_sessions_agentId_workspace_fkey";

-- RenameForeignKey
ALTER TABLE "weekly_report_assistant_runtime_sessions" RENAME CONSTRAINT "weekly_report_asst_runtime_workspace_fkey" TO "weekly_report_assistant_runtime_sessions_workspaceId_fkey";

-- RenameForeignKey
ALTER TABLE "weekly_report_collector_bindings" RENAME CONSTRAINT "weekly_report_collector_bindings_collectorAgentId_workspaceId_f" TO "weekly_report_collector_bindings_collectorAgentId_workspac_fkey";

-- RenameIndex
ALTER INDEX "weekly_report_assistant_chat_sessions_workspaceId_userId_subjec" RENAME TO "weekly_report_assistant_chat_sessions_workspaceId_userId_su_idx";

-- RenameIndex
ALTER INDEX "weekly_report_asst_runtime_agent_idx" RENAME TO "weekly_report_assistant_runtime_sessions_workspaceId_agentI_idx";

-- RenameIndex
ALTER INDEX "weekly_report_asst_runtime_subject_key" RENAME TO "weekly_report_assistant_runtime_sessions_workspaceId_agentI_key";

-- RenameIndex
ALTER INDEX "weekly_report_collector_bindings_collectorAgentId_workspaceId_k" RENAME TO "weekly_report_collector_bindings_collectorAgentId_workspace_key";

-- RenameIndex
ALTER INDEX "weekly_report_collector_bindings_workspaceId_userId_computerId_" RENAME TO "weekly_report_collector_bindings_workspaceId_userId_compute_key";
