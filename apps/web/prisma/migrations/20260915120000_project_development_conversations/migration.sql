ALTER TABLE "conversations" ADD COLUMN "projectId" UUID;

CREATE UNIQUE INDEX "conversations_projectId_key" ON "conversations"("projectId");

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
