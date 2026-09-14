-- Per-user ownership for weekly report send settings (not Workspace-shared).
ALTER TABLE "weekly_report_templates" ADD COLUMN IF NOT EXISTS "ownerId" UUID;

-- Backfill from the Workspace owner membership.
UPDATE "weekly_report_templates" AS t
SET "ownerId" = m."userId"
FROM "workspace_memberships" AS m
WHERE t."ownerId" IS NULL
  AND m."workspaceId" = t."workspaceId"
  AND m."role" = 'owner';

-- Fallback: any membership when no owner row exists.
UPDATE "weekly_report_templates" AS t
SET "ownerId" = (
  SELECT m."userId"
  FROM "workspace_memberships" AS m
  WHERE m."workspaceId" = t."workspaceId"
  ORDER BY m."userId"
  LIMIT 1
)
WHERE t."ownerId" IS NULL;

-- Drop rows that still cannot be attributed (no membership).
DELETE FROM "weekly_report_templates" WHERE "ownerId" IS NULL;

ALTER TABLE "weekly_report_templates" ALTER COLUMN "ownerId" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'weekly_report_templates_ownerId_fkey'
  ) THEN
    ALTER TABLE "weekly_report_templates"
      ADD CONSTRAINT "weekly_report_templates_ownerId_fkey"
      FOREIGN KEY ("ownerId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "weekly_report_templates_workspaceId_ownerId_idx"
  ON "weekly_report_templates"("workspaceId", "ownerId");

-- At most one applied settings row per (workspace, owner).
CREATE UNIQUE INDEX IF NOT EXISTS "weekly_report_templates_one_applied_per_owner_idx"
  ON "weekly_report_templates"("workspaceId", "ownerId")
  WHERE "applied" = true;
