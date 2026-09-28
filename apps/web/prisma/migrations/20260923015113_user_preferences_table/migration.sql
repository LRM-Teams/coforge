-- Move per-user settings out of "users" into a 1:1 table so settings can grow
-- without widening the identity row. NULL means "not chosen"; defaults live in code.
CREATE TABLE "user_preferences" (
    "userId" UUID NOT NULL,
    "timeZone" TEXT,
    "browserNotificationsEnabled" BOOLEAN,
    "conversationOpenMode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "user_preferences_conversationOpenMode_check"
      CHECK ("conversationOpenMode" IN ('newest-read', 'first-unread', 'newest-unread'))
);

ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Copy only values a user actually changed; the column defaults become NULL.
INSERT INTO "user_preferences" ("userId", "timeZone", "browserNotificationsEnabled", "conversationOpenMode", "updatedAt")
SELECT
  "id",
  "timeZone",
  CASE WHEN "browserNotificationsEnabled" THEN TRUE END,
  CASE WHEN "conversationOpenMode" <> 'first-unread' THEN "conversationOpenMode" END,
  CURRENT_TIMESTAMP
FROM "users"
WHERE "timeZone" IS NOT NULL
   OR "browserNotificationsEnabled"
   OR "conversationOpenMode" <> 'first-unread';

ALTER TABLE "users" DROP COLUMN "browserNotificationsEnabled",
DROP COLUMN "conversationOpenMode",
DROP COLUMN "timeZone";
