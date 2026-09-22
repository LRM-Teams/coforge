-- Author delete of a sent weekly report hides it from「我的周报」without
-- removing the Leader's submitted copy.
ALTER TABLE "weekly_reports" ADD COLUMN "hiddenFromAuthor" BOOLEAN NOT NULL DEFAULT false;
