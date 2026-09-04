ALTER TABLE "users"
ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN "avatarObjectKey" TEXT,
ADD COLUMN "avatarContentType" TEXT;
