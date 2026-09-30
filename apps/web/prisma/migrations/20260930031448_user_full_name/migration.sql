-- AlterTable
ALTER TABLE "users" ADD COLUMN     "fullName" TEXT;

-- DataMigration: until now `displayName` was the name a person had set, so it is copied to their
-- full name and left as it is: a nickname equal to the full name labels the same as before. A
-- blank one means no name was given, and one equal to the username is the fallback label an older
-- description-only save stored, not a name the person chose.
UPDATE "users"
   SET "fullName" = NULLIF(BTRIM("displayName"), '')
 WHERE "displayName" IS NOT NULL
   AND BTRIM("displayName") <> "username";

-- A displayName that is only the username labels the same without it, and left in place it would
-- outrank the full name the person is asked for at their next sign-in.
UPDATE "users"
   SET "displayName" = NULL
 WHERE BTRIM("displayName") = "username";
