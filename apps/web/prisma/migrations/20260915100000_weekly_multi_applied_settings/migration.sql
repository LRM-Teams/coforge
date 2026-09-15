-- Allow multiple applied send-settings rows per owner; link reports to a settings stream.
DROP INDEX IF EXISTS "weekly_report_templates_one_applied_per_owner_idx";

ALTER TABLE "weekly_reports" ADD COLUMN IF NOT EXISTS "settingsId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'weekly_reports_settingsId_fkey'
  ) THEN
    ALTER TABLE "weekly_reports"
      ADD CONSTRAINT "weekly_reports_settingsId_fkey"
      FOREIGN KEY ("settingsId") REFERENCES "weekly_report_templates"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "weekly_reports_settingsId_idx"
  ON "weekly_reports"("settingsId");
