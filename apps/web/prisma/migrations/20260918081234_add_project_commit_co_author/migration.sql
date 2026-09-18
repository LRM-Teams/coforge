-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "commitCoAuthor" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "weekly_report_assistant_chat_sessions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "weekly_report_collect_runs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "weekly_report_collect_slots" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "weekly_report_collector_bindings" ALTER COLUMN "id" DROP DEFAULT;

-- RenameForeignKey
ALTER TABLE "weekly_report_collector_bindings" RENAME CONSTRAINT "weekly_report_collector_bindings_collectorAgentId_workspaceId_f" TO "weekly_report_collector_bindings_collectorAgentId_workspac_fkey";

-- RenameIndex
ALTER INDEX "weekly_report_assistant_chat_sessions_workspaceId_userId_subjec" RENAME TO "weekly_report_assistant_chat_sessions_workspaceId_userId_su_idx";

-- RenameIndex
ALTER INDEX "weekly_report_collector_bindings_collectorAgentId_workspaceId_k" RENAME TO "weekly_report_collector_bindings_collectorAgentId_workspace_key";

-- RenameIndex
ALTER INDEX "weekly_report_collector_bindings_workspaceId_userId_computerId_" RENAME TO "weekly_report_collector_bindings_workspaceId_userId_compute_key";
