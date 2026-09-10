-- Link member submissions to the template they were written against.
ALTER TABLE "weekly_reports" ADD COLUMN IF NOT EXISTS "sourceTemplateId" UUID;
CREATE INDEX IF NOT EXISTS "weekly_reports_sourceTemplateId_idx" ON "weekly_reports"("sourceTemplateId");
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'weekly_reports_sourceTemplateId_fkey'
  ) THEN
    ALTER TABLE "weekly_reports"
      ADD CONSTRAINT "weekly_reports_sourceTemplateId_fkey"
      FOREIGN KEY ("sourceTemplateId") REFERENCES "weekly_reports"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
