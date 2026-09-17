-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "uploaderAgentId" UUID,
ALTER COLUMN "uploaderId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "weekly_report_assistants" ALTER COLUMN "id" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "attachments_uploaderAgentId_idx" ON "attachments"("uploaderAgentId");

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaderAgentId_fkey" FOREIGN KEY ("uploaderAgentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
