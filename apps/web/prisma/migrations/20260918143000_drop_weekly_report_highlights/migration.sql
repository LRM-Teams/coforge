-- Remove Workspace Records 「周报要点」(WeeklyReportHighlight) and related comment subjects.

DELETE FROM "record_comments" WHERE "subjectType" = 'highlight' OR "highlightId" IS NOT NULL;

DELETE FROM "weekly_report_assistant_chat_sessions" WHERE "subjectType" = 'highlight';

ALTER TABLE "record_comments" DROP CONSTRAINT IF EXISTS "record_comments_highlightId_fkey";
DROP INDEX IF EXISTS "record_comments_highlightId_idx";
ALTER TABLE "record_comments" DROP COLUMN IF EXISTS "highlightId";

ALTER TABLE "record_comments" DROP CONSTRAINT IF EXISTS "record_comments_subject_type_check";
ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_subject_type_check"
  CHECK ("subjectType" IN ('report', 'cycle'));

DROP TABLE IF EXISTS "weekly_report_highlights";
