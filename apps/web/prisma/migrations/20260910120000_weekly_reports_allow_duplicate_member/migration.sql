-- Allow multiple member weekly reports per author in the same cycle
-- (same titles allowed; create flows are no longer 1:1 with cycle+author+kind).
DROP INDEX IF EXISTS "weekly_reports_cycleId_authorId_kind_key";
CREATE INDEX "weekly_reports_cycleId_authorId_kind_idx" ON "weekly_reports"("cycleId", "authorId", "kind");
