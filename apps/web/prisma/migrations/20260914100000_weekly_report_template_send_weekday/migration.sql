-- ISO weekday for periodic send (1=Monday … 7=Sunday); default Friday.
ALTER TABLE "weekly_report_templates" ADD COLUMN IF NOT EXISTS "sendWeekday" INTEGER NOT NULL DEFAULT 5;
