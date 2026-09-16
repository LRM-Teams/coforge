ALTER TABLE "projects"
  DROP COLUMN "icon",
  ADD COLUMN "iconObjectKey" TEXT,
  ADD COLUMN "iconContentType" TEXT;
