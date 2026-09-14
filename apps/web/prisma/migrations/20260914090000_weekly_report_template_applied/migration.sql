-- Active send settings + optional periodic schedule flag for weekly report templates.
ALTER TABLE "weekly_report_templates" ADD COLUMN IF NOT EXISTS "applied" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "weekly_report_templates" ADD COLUMN IF NOT EXISTS "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "weekly_report_templates_workspaceId_applied_idx"
  ON "weekly_report_templates"("workspaceId", "applied");
